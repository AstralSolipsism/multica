package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/media"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type cancellingMediaExecutor struct {
	calls int
	dir   string
}

func (e *cancellingMediaExecutor) Capabilities() []string { return []string{"media-image-codex-v1"} }
func (e *cancellingMediaExecutor) Submit(ctx context.Context, _ protocol.MediaRequest, _ []media.Input, dir string) (media.Artifact, error) {
	e.calls++
	e.dir = dir
	<-ctx.Done()
	return media.Artifact{}, ctx.Err()
}

func TestMediaCancellationStopsSubmitAndCleansFiles(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/media/jobs/job/status" {
			t.Errorf("unexpected transfer: %s", r.URL.Path)
		}
		w.WriteHeader(409)
	}))
	defer server.Close()
	executor := &cancellingMediaExecutor{}
	d := &Daemon{cfg: Config{MediaExecutor: func(string, string) media.Executor { return executor }}, client: NewClient(server.URL)}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	result := d.executeMedia(ctx, Runtime{ID: "runtime", Provider: "codex"}, protocol.MediaAssignment{Job: protocol.MediaJob{ID: "job", ExpiresAt: time.Now().Add(time.Minute)}})
	if result.Error == "" || executor.calls != 1 || ctx.Err() != nil {
		t.Fatal("remote cancellation did not stop one Submit promptly")
	}
	if _, err := os.Stat(executor.dir); !os.IsNotExist(err) {
		t.Fatal("cancelled job left temporary files")
	}
}
