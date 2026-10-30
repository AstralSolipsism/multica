package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/media"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (d *Daemon) mediaExecutor(provider, profileID string) media.Executor {
	if d.cfg.MediaExecutor == nil {
		return nil
	}
	return d.cfg.MediaExecutor(provider, profileID)
}

func (d *Daemon) withMediaCapabilities(entries []map[string]string) []map[string]any {
	result := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		out := make(map[string]any, len(entry)+1)
		for k, v := range entry {
			out[k] = v
		}
		caps := []string{}
		if executor := d.mediaExecutor(entry["type"], entry["profile_id"]); executor != nil {
			for _, cap := range executor.Capabilities() {
				if protocol.ValidMediaTag(entry["type"], cap) && !slices.Contains(caps, cap) {
					caps = append(caps, cap)
				}
			}
		}
		out["media_capabilities"] = caps
		result = append(result, out)
	}
	return result
}

// Each runtime has its own worker; generation and HTTP transfers never run on
// the heartbeat/WS reader. Join workers on shutdown so temporary files are gone.
func (d *Daemon) mediaLoop(ctx context.Context) {
	workers := map[string]context.CancelFunc{}
	var wg sync.WaitGroup
	defer func() {
		for _, cancel := range workers {
			cancel()
		}
		wg.Wait()
	}()
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		live := map[string]bool{}
		for _, id := range d.allRuntimeIDs() {
			rt := d.findRuntime(id)
			if rt == nil || d.mediaExecutor(rt.Provider, rt.ProfileID) == nil {
				continue
			}
			live[id] = true
			if _, exists := workers[id]; exists {
				continue
			}
			workerCtx, cancel := context.WithCancel(ctx)
			workers[id] = cancel
			wg.Add(1)
			go func(rt Runtime) { defer wg.Done(); d.mediaWorker(workerCtx, rt) }(*rt)
		}
		for id, cancel := range workers {
			if !live[id] {
				cancel()
				delete(workers, id)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *Daemon) mediaRPC(ctx context.Context, method string, request, response any) error {
	status, err := d.wsRPC.CallIfRPCV1Supported(ctx, method, 10*time.Second, request, response)
	if err == nil {
		return nil
	}
	if status != 0 || errors.Is(err, errWSRPCUncertain) {
		return err
	}
	if !errors.Is(err, errWSRPCUnavailable) && !errors.Is(err, errWSRPCWriteBufferFull) {
		return err
	}
	return d.client.postJSON(ctx, "/api/daemon/media/"+strings.TrimPrefix(method, "media."), request, response)
}

func (d *Daemon) mediaWorker(ctx context.Context, rt Runtime) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		var claim protocol.MediaClaimResponse
		err := d.mediaRPC(ctx, "media.claim", protocol.MediaClaimRequest{RuntimeID: rt.ID}, &claim)
		if err == nil && claim.Assignment != nil {
			result := d.executeMedia(ctx, rt, *claim.Assignment)
			// Shutdown cancels Submit/transfers, but must still send the receipt.
			reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			for i := 0; i < 3; i++ {
				if d.mediaRPC(reportCtx, "media.result", result, nil) == nil {
					break
				}
				if i < 2 && !mediaWait(reportCtx, time.Duration(i+1)*time.Second) {
					break
				}
			}
			cancel()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func mediaWait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (d *Daemon) executeMedia(parent context.Context, rt Runtime, assignment protocol.MediaAssignment) protocol.MediaResult {
	result := protocol.MediaResult{RuntimeID: rt.ID, JobID: assignment.Job.ID, Attempt: assignment.Attempt}
	ctx, cancel := context.WithDeadline(parent, assignment.Job.ExpiresAt)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for mediaWait(ctx, 3*time.Second) {
			req, err := d.mediaRequest(ctx, http.MethodGet, assignment, "/status", nil)
			if err != nil {
				return
			}
			resp, err := d.client.client.Do(req)
			if err != nil {
				continue
			}
			resp.Body.Close()
			if resp.StatusCode == 409 || resp.StatusCode == 401 || resp.StatusCode == 403 {
				cancel()
				return
			}
		}
	}()
	defer func() { cancel(); <-done }()
	dir, err := os.MkdirTemp("", "multica-media-")
	if err != nil {
		result.Error = "create media temporary directory failed"
		return result
	}
	defer os.RemoveAll(dir)
	// macOS commonly exposes TempDir through /var -> /private/var. Compare
	// canonical paths on both sides when enforcing the artifact boundary.
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		result.Error = "resolve media temporary directory failed"
		return result
	}
	inputs, err := d.downloadMediaInputs(ctx, assignment, dir)
	if err != nil {
		result.Error = "download media input failed"
		return result
	}
	executor := d.mediaExecutor(rt.Provider, rt.ProfileID)
	if executor == nil {
		result.Error = "media executor unavailable"
		return result
	}
	// Submit is deliberately outside the upload retry loop.
	artifact, err := executor.Submit(ctx, assignment.Job.Request, inputs, dir)
	if err != nil {
		var limited *media.RateLimitError
		if errors.As(err, &limited) {
			result.RateLimited, result.RetryAfter = true, limited.RetryAfter
		} else {
			result.Error = "media executor failed"
		}
		return result
	}
	resolved, err := filepath.EvalSymlinks(artifact.Path)
	if err != nil {
		result.Error = "media output missing"
		return result
	}
	relative, err := filepath.Rel(dir, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		result.Error = "media output must be inside job directory"
		return result
	}
	for attempt := 0; attempt < 3; attempt++ {
		err = d.uploadMediaOutput(ctx, assignment, resolved)
		if err == nil {
			return result
		}
		var reqErr *requestError
		if errors.As(err, &reqErr) && reqErr.StatusCode < 500 && reqErr.StatusCode != 429 {
			break
		}
		if !mediaWait(ctx, time.Duration(attempt+1)*time.Second) {
			break
		}
	}
	result.Error = "media upload failed after local-file retries"
	return result
}

func (d *Daemon) mediaRequest(ctx context.Context, method string, assignment protocol.MediaAssignment, suffix string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.client.baseURL+"/api/media/jobs/"+url.PathEscape(assignment.Job.ID)+suffix, body)
	if err == nil {
		req.Header.Set("Authorization", "Bearer "+assignment.Token)
		d.client.setIdentityHeaders(req)
	}
	return req, err
}

func (d *Daemon) downloadMediaInputs(ctx context.Context, assignment protocol.MediaAssignment, dir string) ([]media.Input, error) {
	inputs := make([]media.Input, 0, len(assignment.Job.Request.Inputs))
	for i, input := range assignment.Job.Request.Inputs {
		req, err := d.mediaRequest(ctx, http.MethodGet, assignment, "/inputs/"+url.PathEscape(input.AttachmentID), nil)
		if err != nil {
			return nil, err
		}
		resp, err := d.client.bundleClient.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			return nil, fmt.Errorf("input HTTP %d", resp.StatusCode)
		}
		ext := ".bin"
		if exts, _ := mime.ExtensionsByType(resp.Header.Get("Content-Type")); len(exts) > 0 {
			ext = exts[0]
		}
		filename := filepath.Join(dir, fmt.Sprintf("input-%d%s", i, ext))
		f, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			resp.Body.Close()
			return nil, err
		}
		n, copyErr := io.Copy(f, io.LimitReader(resp.Body, protocol.MediaMaxBytes+1))
		closeErr := f.Close()
		resp.Body.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if n > protocol.MediaMaxBytes {
			return nil, fmt.Errorf("input too large")
		}
		inputs = append(inputs, media.Input{Role: input.Role, Path: filename})
	}
	return inputs, nil
}

func (d *Daemon) uploadMediaOutput(ctx context.Context, assignment protocol.MediaAssignment, filename string) error {
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > protocol.MediaMaxBytes {
		return fmt.Errorf("invalid media output size/type")
	}
	req, err := d.mediaRequest(ctx, http.MethodPost, assignment, "/output?filename="+url.QueryEscape(filepath.Base(filename)), f)
	if err != nil {
		return err
	}
	req.ContentLength = stat.Size()
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := d.client.bundleClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return &requestError{StatusCode: resp.StatusCode, Body: "media upload failed"}
	}
	var receipt struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&receipt); err != nil {
		return err
	}
	if receipt.ID == "" {
		return fmt.Errorf("missing attachment receipt")
	}
	return nil
}
