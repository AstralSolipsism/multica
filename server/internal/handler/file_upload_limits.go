package handler

import (
	"net/http"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Tests can lower the cap without allocating a full-size request.
var maxUploadSize int64 = 100 << 20

const maxUploadBodySize = (100 << 20) + multipartOverheadBytes

func uploadFileLimit(r *http.Request) int64 {
	if r.URL.Query().Get("media") == "1" {
		return protocol.MediaMaxBytes
	}
	return maxUploadSize
}

func parseUploadForm(w http.ResponseWriter, r *http.Request) error {
	limit := uploadFileLimit(r)
	r.Body = http.MaxBytesReader(w, r.Body, limit+multipartOverheadBytes)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		return err
	}
	for _, header := range r.MultipartForm.File["file"] {
		if header.Size > limit {
			return &http.MaxBytesError{Limit: limit}
		}
	}
	return nil
}
