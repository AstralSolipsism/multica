package daemon

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/internal/daemon/jevsample"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// TestStepDecisionShipsSecretsVerbatim locks OL-1083: the decision path no
// longer redacts — a fake secret inside tool output appears verbatim both in
// the request body sent to the (fake) Jev source and in the collected sample.
func TestStepDecisionShipsSecretsVerbatim(t *testing.T) {
	t.Parallel()
	const secret = "postgres://app:FAKESECRET0123456789@db.internal:5432/orders"
	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		mu.Lock()
		bodies = append(bodies, string(raw))
		mu.Unlock()
		w.Write([]byte(`{"answers":{"effort":{"choice":"high","confidence":0.9}}}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	samples := jevsample.New(dir, "daemon-test", 0, quietTaskLog())
	run := &stepEffortRun{
		TaskID:     "task-secret",
		Provider:   "claude",
		Model:      "claude-sonnet-5-5",
		Clients:    jev.New(jev.Options{Sources: []jev.Source{{Name: "fake", BaseURL: srv.URL, Model: "test"}}}),
		Samples:    samples,
		Trace:      ThinkingDecisionTrace{TaskID: "task-secret", Scope: "step", Step: 2, Provider: "claude", Model: "claude-sonnet-5-5"},
		Goal:       "排查任务调度器偶发卡住的问题",
		Candidates: []agent.ThinkingLevel{{Value: "low"}, {Value: "high"}},
	}
	req := thinkingDecisionRequest{
		Step: 2,
		Tools: []stepToolMaterial{{
			Name: "Read", InputSummary: "config.go",
			ResultText: "dsn := \"" + secret + "\"\nvar x = 1",
		}},
	}
	jevReq, _ := run.buildStepRequest(req)
	record := decideThinking(t.Context(), run.Clients, run.Trace, jevReq, run.Samples)
	if record.Fallback != "" {
		t.Fatalf("decision fell back: %s", record.Fallback)
	}
	mu.Lock()
	wire := strings.Join(bodies, "\n")
	mu.Unlock()
	if !strings.Contains(wire, secret) {
		t.Fatalf("wire body missing the secret:\n%s", wire)
	}
	samples.Close()
	day := time.Now().UTC().Format("20060102")
	raw, err := os.ReadFile(filepath.Join(dir, "decisions-daemon-test-"+day+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), secret) {
		t.Fatalf("sample missing the secret:\n%s", raw)
	}
}
