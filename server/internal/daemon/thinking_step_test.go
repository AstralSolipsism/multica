package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// fakeStepDecider stands in for the Jev client.
type fakeStepDecider struct {
	decision jev.Decision
	err      error
}

func (f *fakeStepDecider) Decide(context.Context, jev.Request) (jev.Decision, error) {
	return f.decision, f.err
}

func newStepEffortTestDaemon(t *testing.T) (*Daemon, *stepEffortRun) {
	t.Helper()
	d := &Daemon{cfg: Config{CLIVersion: "v1.0.0"}, logger: slog.Default()}
	run := &stepEffortRun{
		TaskID:      "task-effort",
		Provider:    "claude",
		Model:       "claude-sonnet-5-5",
		Clients:     &fakeStepDecider{},
		Trace:       ThinkingDecisionTrace{TaskID: "task-effort", Scope: "step", Provider: "claude", Model: "claude-sonnet-5-5"},
		Candidates:  []agent.ThinkingLevel{{Value: "low"}, {Value: "medium"}, {Value: "high"}, {Value: "xhigh"}, {Value: "max"}},
		EnabledPath: filepath.Join(t.TempDir(), "enabled"),
	}
	d.stepEffort.add(run)
	d.registerActiveRepoCheckoutTask("mat_effort_test", activeRepoCheckoutTask{TaskID: "task-effort"})
	return d, run
}

func stepEffortRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/tasks/task-effort/thinking-decision", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer mat_effort_test")
	return req
}

func decodeDecision(t *testing.T, rec *httptest.ResponseRecorder) thinkingDecisionResponse {
	t.Helper()
	var resp thinkingDecisionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return resp
}

func TestThinkingDecisionAuth(t *testing.T) {
	t.Parallel()
	d, _ := newStepEffortTestDaemon(t)

	for name, build := range map[string]func() *http.Request{
		"no token": func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/tasks/task-effort/thinking-decision", strings.NewReader(`{}`))
		},
		"wrong token": func() *http.Request {
			req := httptest.NewRequest(http.MethodPost, "/tasks/task-effort/thinking-decision", strings.NewReader(`{}`))
			req.Header.Set("Authorization", "Bearer mat_other")
			return req
		},
	} {
		rec := httptest.NewRecorder()
		d.taskEndpointsHandler().ServeHTTP(rec, build())
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d: %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestThinkingDecisionMismatchedTaskForbidden(t *testing.T) {
	t.Parallel()
	d, _ := newStepEffortTestDaemon(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tasks/task-someone-else/thinking-decision", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer mat_effort_test")
	d.taskEndpointsHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestThinkingDecisionNotEnabledWithoutMarker(t *testing.T) {
	t.Parallel()
	d, run := newStepEffortTestDaemon(t)
	// No marker written: the endpoint answers not-enabled without touching
	// Jev (the fake decider would return a level if asked).
	run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "high"}}
	rec := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(`{"step":2}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeDecision(t, rec)
	if resp.Enabled == nil || *resp.Enabled {
		t.Fatalf("expected enabled=false, got %+v", resp)
	}
	if resp.Level != "" || resp.Fallback != "" {
		t.Fatalf("not-enabled answer carried a decision: %+v", resp)
	}
}

func TestThinkingDecisionRevokedMidRun(t *testing.T) {
	t.Parallel()
	d, run := newStepEffortTestDaemon(t)
	run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "high"}}
	if err := os.WriteFile(run.EnabledPath, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(`{"step":2}`))
	if resp := decodeDecision(t, rec); resp.Level != "high" {
		t.Fatalf("expected high with the marker present, got %+v", resp)
	}
	// Revocation removes the marker; the next request answers not-enabled.
	d.setStepEffortEnabled("task-effort", false)
	rec = httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(`{"step":3}`))
	resp := decodeDecision(t, rec)
	if resp.Enabled == nil || *resp.Enabled {
		t.Fatalf("expected enabled=false after revocation, got %+v", resp)
	}
}

func TestThinkingDecisionFallbacks(t *testing.T) {
	t.Parallel()
	d, run := newStepEffortTestDaemon(t)
	if err := os.WriteFile(run.EnabledPath, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}

	run.Clients = &fakeStepDecider{err: &jev.FallbackError{Reason: jev.ReasonTimeout}}
	rec := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(`{"step":2}`))
	if resp := decodeDecision(t, rec); resp.Fallback != string(jev.ReasonTimeout) || resp.Level != "" {
		t.Fatalf("timeout fallback: %+v", resp)
	}

	run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "ultra"}}
	rec = httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(`{"step":2}`))
	if resp := decodeDecision(t, rec); resp.Fallback != string(jev.ReasonInvalid) || resp.Level != "" {
		t.Fatalf("level outside candidates must fall back: %+v", resp)
	}
}

func TestThinkingDecisionSuccessStaysInCandidates(t *testing.T) {
	t.Parallel()
	d, run := newStepEffortTestDaemon(t)
	if err := os.WriteFile(run.EnabledPath, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	run.Clients = &fakeStepDecider{decision: jev.Decision{Level: "xhigh", Confidence: 0.9, Probabilities: map[string]float64{"xhigh": 0.9, "low": 0.1}, Source: "fake"}}
	rec := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(rec, stepEffortRequest(`{"step":3,"assistant_text":"reading code","tools":[{"name":"Read","is_error":false,"input_summary":"scheduler.go","result_text":"func A() {}"}],"error_text":""}`))
	resp := decodeDecision(t, rec)
	if resp.Level != "xhigh" || resp.Confidence != 0.9 || resp.Source != "fake" {
		t.Fatalf("decision: %+v", resp)
	}
	if resp.Probabilities["xhigh"] != 0.9 || len(resp.Probabilities) != 2 {
		t.Fatalf("probabilities: %+v", resp.Probabilities)
	}
}

func TestStepEffortBuildsStateWithErrorFeatures(t *testing.T) {
	t.Parallel()
	_, run := newStepEffortTestDaemon(t)
	if err := os.WriteFile(run.EnabledPath, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	first := thinkingDecisionRequest{Step: 2, ErrorText: "scheduler.go:4:2: fmt imported and not used"}
	req, input := run.buildStepRequest(first)
	if input.ErrorFeatures == "" || input.RepeatedErrors != 1 {
		t.Fatalf("first error: features=%q repeats=%d", input.ErrorFeatures, input.RepeatedErrors)
	}
	if input.Step != 2 {
		t.Fatalf("step: %d", input.Step)
	}
	state, _ := req.State.(string)
	if !strings.Contains(state, `"step":2`) {
		t.Fatalf("state missing step: %s", state)
	}
	// The same error again counts as a repeat.
	_, input = run.buildStepRequest(first)
	if input.RepeatedErrors != 2 {
		t.Fatalf("repeat count: %d", input.RepeatedErrors)
	}
}
