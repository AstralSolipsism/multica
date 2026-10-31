package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/media"
	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestMediaNativeProcess(t *testing.T) {
	counter := os.Getenv("MULTICA_TEST_MEDIA_COUNTER")
	if counter == "" {
		return
	}
	write := func(v any) { b, _ := json.Marshal(v); _, _ = os.Stdout.Write(append(b, '\n')) }
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &req)
		result := map[string]any{}
		if req.Method == "initialized" {
			continue
		}
		if req.Method == "thread/start" {
			result["thread"] = map[string]string{"id": "native"}
		}
		if req.Method == "turn/start" {
			f, _ := os.OpenFile(counter, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			_, _ = f.WriteString("submit\n")
			_ = f.Close()
			path := filepath.Join(os.Getenv("CODEX_HOME"), "output.png")
			f, _ = os.Create(path)
			_ = png.Encode(f, image.NewRGBA(image.Rect(0, 0, 3, 3)))
			_ = f.Close()
			write(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "native", "item": map[string]string{"id": "one", "type": "imageGeneration", "status": "completed", "savedPath": path}}})
			write(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "native", "turn": map[string]string{"status": "completed"}}})
		}
		write(map[string]any{"id": req.ID, "result": result})
	}
	os.Exit(0)
}

func TestMediaNativeUploadRetryDoesNotRegenerate(t *testing.T) {
	command, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"fixture":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	counter := filepath.Join(t.TempDir(), "calls")
	t.Setenv("MULTICA_TEST_MEDIA_COUNTER", counter)
	executor := &media.Codex{Command: agent.NewCommand(command, []string{"-test.run=^TestMediaNativeProcess$", "--"}), Home: home}
	var uploads atomic.Int32
	var outputPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(200)
			return
		}
		if r.Header.Get("Authorization") != "Bearer job-token" {
			t.Error("transfer did not use the scoped job token")
		}
		b, _ := io.ReadAll(r.Body)
		if http.DetectContentType(b) != "image/png" {
			t.Error("upload was not the native PNG")
		}
		if uploads.Add(1) < 3 {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"id":"native-output-attachment"}`))
	}))
	defer server.Close()
	d := &Daemon{cfg: Config{MediaExecutor: func(string, string) media.Executor {
		return &recordingNativeExecutor{Executor: executor, path: &outputPath}
	}}, client: NewClient(server.URL)}
	result := d.executeMedia(t.Context(), Runtime{ID: "host", Provider: "codex"}, protocol.MediaAssignment{Token: "job-token", Job: protocol.MediaJob{ID: "job", ExpiresAt: time.Now().Add(time.Minute), Request: protocol.MediaRequest{Capability: "image-generate", Provider: "codex", Prompt: "fixture"}}})
	if result.Error != "" || result.RateLimited || uploads.Load() != 3 {
		t.Fatalf("result=%+v uploads=%d", result, uploads.Load())
	}
	calls, err := os.ReadFile(counter)
	if err != nil || string(calls) != "submit\n" {
		t.Fatalf("model replayed: %q %v", calls, err)
	}
	if _, err := os.Stat(outputPath); !os.IsNotExist(err) {
		t.Fatalf("native output retained after upload: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "auth.json")); err != nil {
		t.Fatal("host auth removed during job cleanup")
	}
}

type recordingNativeExecutor struct {
	media.Executor
	path *string
}

func (e *recordingNativeExecutor) Submit(ctx context.Context, r protocol.MediaRequest, in []media.Input, dir string) (media.Artifact, error) {
	a, err := e.Executor.Submit(ctx, r, in, dir)
	*e.path = a.Path
	return a, err
}
