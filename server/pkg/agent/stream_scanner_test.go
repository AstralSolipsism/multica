package agent

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
)

// TestAgentStreamScannerReadsPastOldTenMiBCap is the regression for MUL-5722 /
// GH#4520: Codex serializes a whole thread into the single `thread/resume`
// response line, and the previous 10 MiB bound turned any thread past that
// size into a permanent "bufio.Scanner: token too long" resume failure.
func TestAgentStreamScannerReadsPastOldTenMiBCap(t *testing.T) {
	t.Parallel()

	const oldCap = 10 * 1024 * 1024
	if agentStreamMaxLineBytes <= oldCap {
		t.Fatalf("agentStreamMaxLineBytes must exceed the old %d-byte cap, got %d",
			oldCap, agentStreamMaxLineBytes)
	}

	line := strings.Repeat("x", oldCap+1024*1024)
	scanner := newAgentStreamScanner(strings.NewReader(line + "\n"))

	if !scanner.Scan() {
		t.Fatalf("expected a %d-byte line to scan, got err=%v", len(line), scanner.Err())
	}
	if got := len(scanner.Bytes()); got != len(line) {
		t.Fatalf("expected %d bytes, got %d", len(line), got)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("unexpected scanner error: %v", err)
	}
}

type chunkedStreamReader struct {
	io.Reader
	chunkSize int
}

func (r chunkedStreamReader) Read(p []byte) (int, error) {
	return r.Reader.Read(p[:min(len(p), r.chunkSize)])
}

func TestAgentStreamScannerMatchesScanLinesAcrossChunks(t *testing.T) {
	for _, input := range []string{"", "\n\n", "a\r\nb\nc\r", "a\r\rb\nlast", "\r\n\r\n", "尾行", "a\x00b\nend"} {
		for _, chunkSize := range []int{1, 2, 3, 8} {
			t.Run(fmt.Sprintf("%q/chunk=%d", input, chunkSize), func(t *testing.T) {
				want := []string{}
				standard := bufio.NewScanner(strings.NewReader(input))
				for standard.Scan() {
					want = append(want, standard.Text())
				}
				got := []string{}
				scanner := newAgentStreamScanner(chunkedStreamReader{strings.NewReader(input), chunkSize})
				for scanner.Scan() {
					got = append(got, scanner.Text())
				}
				if !slices.Equal(got, want) || scanner.Err() != nil {
					t.Fatalf("got %q, err=%v; want %q", got, scanner.Err(), want)
				}
			})
		}
	}
}

func TestAgentStreamScannerChunkedLimit(t *testing.T) {
	for _, size := range []int{agentStreamMaxLineBytes - 1, agentStreamMaxLineBytes} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			line := strings.Repeat("x", size)
			// The short lines exercise resetting the search offset and moving the
			// buffer before and after a line that grows to the scanner's limit.
			scanner := newAgentStreamScanner(chunkedStreamReader{strings.NewReader("init\n" + line + "\nend\n"), 8192})
			if !scanner.Scan() || scanner.Text() != "init" {
				t.Fatal("missing initial line")
			}
			if size == agentStreamMaxLineBytes {
				if scanner.Scan() || !errors.Is(scanner.Err(), bufio.ErrTooLong) {
					t.Fatalf("expected bounded overflow, got %v", scanner.Err())
				}
				return
			}
			if !scanner.Scan() || scanner.Text() != line {
				t.Fatalf("valid line was lost or truncated: %v", scanner.Err())
			}
			if !scanner.Scan() || scanner.Text() != "end" || scanner.Scan() || scanner.Err() != nil {
				t.Fatalf("unexpected trailing line or error: %v", scanner.Err())
			}
		})
	}
}

func BenchmarkAgentStreamScannerChunkedLongLine(b *testing.B) {
	input := strings.Repeat("x", agentStreamMaxLineBytes-1) + "\n"
	b.SetBytes(int64(len(input)))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		scanner := newAgentStreamScanner(chunkedStreamReader{strings.NewReader(input), 8192})
		if !scanner.Scan() || len(scanner.Bytes()) != len(input)-1 || scanner.Scan() || scanner.Err() != nil {
			b.Fatalf("failed to read long line: %v", scanner.Err())
		}
	}
}

// TestAgentStreamScannerStillFailsClosedAboveCap keeps the bound a bound: the
// backends' overflow handling (fail the turn rather than silently truncate an
// event) depends on Scan reporting bufio.ErrTooLong, so raising the cap must
// not mean removing it.
func TestAgentStreamScannerStillFailsClosedAboveCap(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	buf.Grow(agentStreamMaxLineBytes + 2)
	for i := 0; i < agentStreamMaxLineBytes+1; i++ {
		buf.WriteByte('x')
	}
	buf.WriteByte('\n')

	scanner := newAgentStreamScanner(&buf)

	if scanner.Scan() {
		t.Fatalf("expected an over-cap line to fail, scanned %d bytes", len(scanner.Bytes()))
	}
	if err := scanner.Err(); !errors.Is(err, bufio.ErrTooLong) {
		t.Fatalf("expected bufio.ErrTooLong, got %v", err)
	}
}
