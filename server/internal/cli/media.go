package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// UploadMediaInput streams a multipart body without copying the file into RAM.
func (c *APIClient) UploadMediaInput(ctx context.Context, filename string) (AttachmentResponse, error) {
	var out AttachmentResponse
	f, err := os.Open(filename)
	if err != nil {
		return out, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return out, err
	}
	if !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > protocol.MediaMaxBytes {
		return out, fmt.Errorf("input must be a regular file of 1 byte to 1 GiB")
	}
	var framing bytes.Buffer
	writer := multipart.NewWriter(&framing)
	if _, err := writer.CreateFormFile("file", filepath.Base(filename)); err != nil {
		return out, err
	}
	prefix := append([]byte(nil), framing.Bytes()...)
	framing.Reset()
	if err := writer.Close(); err != nil {
		return out, err
	}
	suffix := framing.Bytes()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/upload-file?media=1", io.MultiReader(bytes.NewReader(prefix), f, bytes.NewReader(suffix)))
	if err != nil {
		return out, err
	}
	req.ContentLength = int64(len(prefix)) + stat.Size() + int64(len(suffix))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	c.setHeaders(req)
	client := *c.HTTPClient
	client.Timeout = 0
	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out, newHTTPError(http.MethodPost, "/api/upload-file", resp)
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out)
	if err == nil && out.ID == "" {
		err = fmt.Errorf("upload returned no attachment id; workspace context is required")
	}
	return out, err
}

func (c *APIClient) WaitMediaJob(ctx context.Context, id string, interval time.Duration) (protocol.MediaJob, error) {
	var job protocol.MediaJob
	for {
		if err := c.GetJSON(ctx, "/api/media/jobs/"+url.PathEscape(id), &job); err != nil {
			return job, err
		}
		if job.ID != id || !slices.Contains([]string{"queued", "running", "completed", "failed", "cancelled"}, job.State) {
			return job, fmt.Errorf("invalid media job response")
		}
		if job.Terminal() {
			return job, nil
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return job, ctx.Err()
		case <-timer.C:
		}
	}
}

// DownloadMediaOutput is called only for an explicit --out. Rename commits the
// download, so a broken transfer never replaces an existing destination.
func (c *APIClient) DownloadMediaOutput(ctx context.Context, attachmentID, filename string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/attachments/"+url.PathEscape(attachmentID)+"/download", nil)
	if err != nil {
		return err
	}
	c.setHeaders(req)
	client := *c.HTTPClient
	client.Timeout = 0
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return newHTTPError(http.MethodGet, req.URL.Path, resp)
	}
	f, err := os.CreateTemp(filepath.Dir(filename), ".multica-media-download-")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	n, copyErr := io.Copy(f, io.LimitReader(resp.Body, protocol.MediaMaxBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n > protocol.MediaMaxBytes {
		return fmt.Errorf("media output exceeds 1 GiB")
	}
	return os.Rename(temp, filename)
}
