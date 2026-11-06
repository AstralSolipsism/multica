// Package imagemetadata reads image headers without decoding pixel data.
package imagemetadata

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
)

// Metadata is optional; cap work even if malformed headers never reach pixels.
const maxHeaderBytes = 1 << 20

type Size struct {
	Width  int32
	Height int32
}

// Dimensions returns the size displayed by browsers, including JPEG orientation.
// Unsupported or malformed files simply retain the unknown-size placeholder.
func Dimensions(data []byte) (Size, bool) {
	return DimensionsFromReader(bytes.NewReader(data))
}

// DimensionsFromReader reads headers without buffering the uploaded file.
// The caller must rewind the reader before uploading its contents.
func DimensionsFromReader(reader io.ReadSeeker) (Size, bool) {
	cfg, format, err := image.DecodeConfig(io.LimitReader(reader, maxHeaderBytes))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > math.MaxInt32 || cfg.Height > math.MaxInt32 {
		return Size{}, false
	}
	width, height := int32(cfg.Width), int32(cfg.Height)
	if format == "jpeg" && jpegOrientationFromReader(reader) >= 5 {
		width, height = height, width
	}
	return Size{Width: width, Height: height}, true
}

func tiffOrientation(data []byte) int {
	if len(data) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(data[2:4]) != 42 {
		return 1
	}
	offset := uint64(order.Uint32(data[4:8]))
	if offset < 8 || offset+2 > uint64(len(data)) {
		return 1
	}
	count := int(order.Uint16(data[offset:]))
	for i := 0; i < count; i++ {
		entry := offset + 2 + uint64(i)*12
		if entry+12 > uint64(len(data)) {
			return 1
		}
		if order.Uint16(data[entry:]) != 0x0112 {
			continue
		}
		if order.Uint16(data[entry+2:]) != 3 || order.Uint32(data[entry+4:]) != 1 {
			return 1
		}
		if value := int(order.Uint16(data[entry+8:])); value >= 1 && value <= 8 {
			return value
		}
		return 1
	}
	return 1
}

func jpegOrientationFromReader(reader io.ReadSeeker) int {
	if _, err := reader.Seek(2, io.SeekStart); err != nil {
		return 1
	}
	header := bufio.NewReader(io.LimitReader(reader, maxHeaderBytes-2))
	for {
		var marker [2]byte
		if _, err := io.ReadFull(header, marker[:]); err != nil || marker[0] != 0xff {
			return 1
		}
		for marker[1] == 0xff {
			next, err := header.ReadByte()
			if err != nil {
				return 1
			}
			marker[1] = next
		}
		// EXIF precedes the first frame. C4 (DHT), C8 (JPG) and CC (DAC)
		// are the non-frame markers in the C0-CF range.
		isFrame := marker[1] >= 0xc0 && marker[1] <= 0xcf && marker[1] != 0xc4 && marker[1] != 0xc8 && marker[1] != 0xcc
		if isFrame || marker[1] == 0xda || marker[1] == 0xd9 {
			return 1
		}
		var size [2]byte
		if _, err := io.ReadFull(header, size[:]); err != nil {
			return 1
		}
		length := int(binary.BigEndian.Uint16(size[:])) - 2
		if length < 0 {
			return 1
		}
		if marker[1] == 0xe1 {
			payload := make([]byte, length)
			if _, err := io.ReadFull(header, payload); err != nil {
				return 1
			}
			if bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
				return tiffOrientation(payload[6:])
			}
		} else if _, err := header.Discard(length); err != nil {
			return 1
		}
	}
}
