package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
)

func TestThinkingFixtureExport(t *testing.T) {
	raw, err := json.MarshalIndent(ThinkingEvaluationFixtures(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	path := filepath.Join("testdata", "thinking-fixtures.json")
	if os.Getenv("MULTICA_UPDATE_THINKING_FIXTURES") == "1" {
		if err := os.WriteFile(path, raw, 0644); err != nil {
			t.Fatal(err)
		}
	}
	exported, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(exported, raw) {
		t.Fatal("fixture export drift: run MULTICA_UPDATE_THINKING_FIXTURES=1 go test ./internal/daemon -run '^TestThinkingFixtureExport$'")
	}
}

type thinkingEvaluationResult struct {
	ID               string             `json:"id"`
	Scope            string             `json:"scope"`
	CandidateGroup   string             `json:"candidate_group"`
	ExpectedCategory string             `json:"expected_category"`
	Choice           string             `json:"choice"`
	Confidence       float64            `json:"confidence"`
	Probabilities    map[string]float64 `json:"probabilities"`
	Source           string             `json:"source"`
	LatencyMS        int64              `json:"latency_ms"`
	Fallback         string             `json:"fallback,omitempty"`
	Passed           bool               `json:"passed"`
}

func TestThinkingEvaluationLive(t *testing.T) {
	if os.Getenv("MULTICA_RUN_JEV_LIVE") != "1" {
		t.Skip("set MULTICA_RUN_JEV_LIVE=1 to call the configured Jev sources")
	}
	// Use the daemon's config loader, while keeping runtime discovery isolated
	// from installed agent CLIs and accounts. MULTICA_JEV_* stays untouched.
	stageFakeAgent(t)
	redirectTestHome(t, t.TempDir())
	t.Setenv("SHELL", filepath.Join(t.TempDir(), "missing-shell"))
	cfg, err := LoadConfig(Overrides{ServerURL: "http://localhost:0", WorkspacesRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	client := jev.New(jev.Options{Disabled: cfg.JevDisabled, Sources: cfg.JevSources, Timeout: cfg.JevTimeout})
	var results []thinkingEvaluationResult
	for _, fixture := range ThinkingEvaluationFixtures() {
		record := decideThinking(context.Background(), client, ThinkingDecisionTrace{Scope: fixture.Scope, Provider: fixture.CandidateGroup}, fixture.Request)
		decision := record.Decision
		passed := record.Fallback == "" && fixture.Accepts(decision.Level)
		results = append(results, thinkingEvaluationResult{ID: fixture.ID, Scope: fixture.Scope, CandidateGroup: fixture.CandidateGroup, ExpectedCategory: fixture.ExpectedCategory,
			Choice: decision.Level, Confidence: decision.Confidence, Probabilities: decision.Probabilities, Source: decision.Source, LatencyMS: decision.LatencyMS, Fallback: record.Fallback, Passed: passed})
		t.Logf("%s/%s/%s: %s confidence=%.3f source=%s latency_ms=%d fallback=%s pass=%v", fixture.CandidateGroup, fixture.Scope, fixture.ID, decision.Level, decision.Confidence, decision.Source, decision.LatencyMS, record.Fallback, passed)
		if !passed {
			t.Errorf("%s/%s: expected %s, got %q (%s)", fixture.CandidateGroup, fixture.ID, fixture.ExpectedCategory, decision.Level, record.Fallback)
		}
	}
	path := os.Getenv("MULTICA_JEV_EVAL_OUTPUT")
	if path == "" {
		path = "thinking-evaluation-results.json"
	}
	raw, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	t.Logf("results written to %s", path)
}
