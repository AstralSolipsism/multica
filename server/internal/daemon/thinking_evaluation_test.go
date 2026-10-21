package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
)

func TestThinkingFixtureExport(t *testing.T) {
	fixtures, err := ThinkingEvaluationFixtures()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.MarshalIndent(fixtures, "", "  ")
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

func TestThinkingFixtureWireParity(t *testing.T) {
	var exported []ThinkingEvaluationFixture
	raw, err := os.ReadFile(filepath.Join("testdata", "thinking-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &exported); err != nil {
		t.Fatal(err)
	}
	fixtures, err := ThinkingEvaluationFixtures()
	if err != nil {
		t.Fatal(err)
	}
	if len(exported) != len(fixtures) {
		t.Fatal("fixture count differs")
	}
	requests := make(chan struct {
		State     string          `json:"state"`
		Questions json.RawMessage `json:"questions"`
	}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			State     string          `json:"state"`
			Questions json.RawMessage `json:"questions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		requests <- request
		fmt.Fprint(w, `{"answers":{"effort":{"choice":"low"}}}`)
	}))
	defer srv.Close()
	client := jev.New(jev.Options{Sources: []jev.Source{{Name: "fake", BaseURL: srv.URL, Model: "test"}}})
	for i, fixture := range fixtures {
		if _, err := client.Decide(t.Context(), fixture.Request); err != nil {
			t.Fatal(err)
		}
		request := <-requests
		var questions bytes.Buffer
		if err := json.Compact(&questions, exported[i].Questions); err != nil {
			t.Fatal(err)
		}
		if request.State != exported[i].State || !bytes.Equal(request.Questions, questions.Bytes()) {
			t.Fatalf("%s/%s: exported state/questions differ from HTTP request", fixture.CandidateGroup, fixture.ID)
		}
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
	fixtures, err := ThinkingEvaluationFixtures()
	if err != nil {
		t.Fatal(err)
	}
	var results []thinkingEvaluationResult
	for _, fixture := range fixtures {
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
		file, err := os.CreateTemp("", "multica-thinking-evaluation-*.json")
		if err != nil {
			t.Fatal(err)
		}
		path = file.Name()
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
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
