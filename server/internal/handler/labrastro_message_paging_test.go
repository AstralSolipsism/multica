package handler

import (
	"net/http/httptest"
	"testing"
)

func TestMessageDeliveryPagingOffsetBounds(t *testing.T) {
	for _, tt := range []struct {
		query string
		want  int32
	}{
		{"", 0}, {"offset=1", 1}, {"offset=2147483647", 2147483647},
		{"offset=-1", 0}, {"offset=2147483648", 0},
		{"offset=4294967297", 0}, {"offset=999999999999999999999", 0},
	} {
		t.Run(tt.query, func(t *testing.T) {
			_, offset := messageDeliveryPaging(httptest.NewRequest("GET", "/?"+tt.query, nil))
			if offset != tt.want {
				t.Fatalf("offset = %d, want %d", offset, tt.want)
			}
		})
	}
}
