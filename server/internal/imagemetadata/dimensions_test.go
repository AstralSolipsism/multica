package imagemetadata

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"testing"
	"time"
)

func TestDimensions(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 80, 40))
	for name, encode := range map[string]func(*bytes.Buffer) error{
		"png":  func(b *bytes.Buffer) error { return png.Encode(b, img) },
		"jpeg": func(b *bytes.Buffer) error { return jpeg.Encode(b, img, nil) },
		"gif": func(b *bytes.Buffer) error {
			return gif.Encode(b, image.NewPaletted(img.Rect, color.Palette{color.White}), nil)
		},
	} {
		t.Run(name, func(t *testing.T) {
			var b bytes.Buffer
			if err := encode(&b); err != nil {
				t.Fatal(err)
			}
			if size, ok := Dimensions(b.Bytes()); !ok || size != (Size{80, 40}) {
				t.Fatalf("Dimensions = %+v, %v", size, ok)
			}
		})
	}
	for _, data := range [][]byte{nil, []byte("not an image"), []byte("\x89PNG\r\n\x1a\n")} {
		if size, ok := Dimensions(data); ok || size != (Size{}) {
			t.Fatalf("invalid file returned %+v, %v", size, ok)
		}
	}
}

func TestDimensionsFromReaderDoesNotBufferUpload(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "upload-*.png")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := png.Encode(file, image.NewRGBA(image.Rect(0, 0, 80, 40))); err != nil {
		t.Fatal(err)
	}
	// A sparse tail models a large upload without allocating its body.
	if err := file.Truncate(100 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	reader := &countingReadSeeker{ReadSeeker: file}
	if size, ok := DimensionsFromReader(reader); !ok || size != (Size{80, 40}) {
		t.Fatalf("DimensionsFromReader = %+v, %v", size, ok)
	}
	if reader.bytesRead > 64<<10 {
		t.Fatalf("read %d bytes to inspect image headers", reader.bytesRead)
	}
}

type countingReadSeeker struct {
	io.ReadSeeker
	bytesRead    int
	readCalls    int
	seekCalls    int
	maxReadCalls int
}

func (r *countingReadSeeker) Read(p []byte) (int, error) {
	r.readCalls++
	// Fail fast if a regression would otherwise perform millions of syscalls.
	if r.maxReadCalls > 0 && r.readCalls > r.maxReadCalls {
		return 0, io.ErrUnexpectedEOF
	}
	n, err := r.ReadSeeker.Read(p)
	r.bytesRead += n
	return n, err
}

func (r *countingReadSeeker) Seek(offset int64, whence int) (int64, error) {
	r.seekCalls++
	return r.ReadSeeker.Seek(offset, whence)
}

func TestDimensionsFromReaderJPEGDiskPadding(t *testing.T) {
	// JFIF followed by an 80x40 SOF0 lets DecodeConfig finish before the tail.
	header := []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" +
		"\xff\xc0\x00\x11\x08\x00\x28\x00\x50\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00")
	for _, sizeMiB := range []int{1, 4, 16} {
		t.Run(fmt.Sprintf("%dMiB", sizeMiB), func(t *testing.T) {
			file := jpegPaddingFile(t, header, sizeMiB<<20)
			reader := &countingReadSeeker{ReadSeeker: file, maxReadCalls: 32}
			started := time.Now()
			if size, ok := DimensionsFromReader(reader); !ok || size != (Size{80, 40}) {
				t.Fatalf("DimensionsFromReader = %+v, %v", size, ok)
			}
			t.Logf("metadata: %s, %d bytes, %d reads, %d seeks", time.Since(started), reader.bytesRead, reader.readCalls, reader.seekCalls)
			if reader.bytesRead > 64<<10 || reader.readCalls > 32 || reader.seekCalls > 2 {
				t.Fatalf("scanned JPEG body: %+v", reader)
			}
		})
	}
}

func TestJPEGHeaderScanLimit(t *testing.T) {
	// Padding before SOF must be bounded in BOTH DecodeConfig and EXIF scanning.
	file := jpegPaddingFile(t, []byte{0xff, 0xd8}, 2<<20)
	for _, orientationOnly := range []bool{false, true} {
		t.Run(fmt.Sprintf("orientationOnly=%t", orientationOnly), func(t *testing.T) {
			if _, err := file.Seek(0, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			reader := &countingReadSeeker{ReadSeeker: file, maxReadCalls: 512}
			if orientationOnly {
				if got := jpegOrientationFromReader(reader); got != 1 {
					t.Fatalf("unavailable orientation = %d", got)
				}
			} else if _, ok := DimensionsFromReader(reader); ok {
				t.Fatal("accepted JPEG without a frame header")
			}
			if reader.bytesRead > 1<<20 || reader.readCalls > 512 || reader.seekCalls > 2 {
				t.Fatalf("unbounded JPEG header scan: %+v", reader)
			}
		})
	}
}

func jpegPaddingFile(t *testing.T, header []byte, padding int) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "upload-*.jpg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	if _, err := file.Write(header); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte{0xff}, 64<<10)
	for remaining := padding; remaining > 0; remaining -= len(chunk) {
		if _, err := file.Write(chunk[:min(remaining, len(chunk))]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestDimensionsReadsHeaderWithoutPixelDecode(t *testing.T) {
	// A valid IHDR with no pixel data is sufficient, even for huge images.
	header := make([]byte, 13)
	binary.BigEndian.PutUint32(header, 100000)
	binary.BigEndian.PutUint32(header[4:], 50000)
	header[8], header[9] = 8, 2
	chunk := append([]byte("IHDR"), header...)
	data := append([]byte("\x89PNG\r\n\x1a\n"), 0, 0, 0, 13)
	data = append(data, chunk...)
	data = binary.BigEndian.AppendUint32(data, crc32.ChecksumIEEE(chunk))
	if _, err := png.Decode(bytes.NewReader(data)); err == nil {
		t.Fatal("fixture must not contain decodable pixels")
	}
	if size, ok := Dimensions(data); !ok || size != (Size{100000, 50000}) {
		t.Fatalf("Dimensions = %+v, %v", size, ok)
	}
}

func TestDimensionsJPEGOrientation(t *testing.T) {
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 80, 40)), nil); err != nil {
		t.Fatal(err)
	}
	for _, order := range []binary.ByteOrder{binary.BigEndian, binary.LittleEndian} {
		for orientation := uint16(1); orientation <= 8; orientation++ {
			tiff := make([]byte, 26)
			copy(tiff, "MM")
			if order == binary.LittleEndian {
				copy(tiff, "II")
			}
			order.PutUint16(tiff[2:], 42)
			order.PutUint32(tiff[4:], 8)
			order.PutUint16(tiff[8:], 1)
			order.PutUint16(tiff[10:], 0x0112)
			order.PutUint16(tiff[12:], 3)
			order.PutUint32(tiff[14:], 1)
			order.PutUint16(tiff[18:], orientation)
			payload := append([]byte("Exif\x00\x00"), tiff...)
			// Padding before APP1 must not hide valid orientation metadata.
			data := append([]byte{0xff, 0xd8, 0xff, 0xff, 0xff, 0xe1}, byte((len(payload)+2)>>8), byte(len(payload)+2))
			data = append(data, payload...)
			data = append(data, b.Bytes()[2:]...)
			want := Size{80, 40}
			if orientation >= 5 {
				want = Size{40, 80}
			}
			if size, ok := Dimensions(data); !ok || size != want {
				t.Fatalf("orientation %d: got %+v, %v; want %+v", orientation, size, ok, want)
			}
		}
	}
}

func TestMalformedEXIFFallsBack(t *testing.T) {
	for _, data := range [][]byte{
		nil, []byte("Exif"),
		[]byte("MM\x00\x2a\xff\xff\xff\xff"),
		[]byte("II\x2a\x00\x08\x00\x00\x00\xff\xff"),
	} {
		if got := tiffOrientation(data); got != 1 {
			t.Fatalf("orientation = %d", got)
		}
	}
}
