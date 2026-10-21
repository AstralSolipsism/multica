package agent

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestAdaptThinkingCandidates(t *testing.T) {
	raw, err := os.ReadFile("testdata/adapt_thinking_candidates.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name       string          `json:"name"`
		Levels     []ThinkingLevel `json:"levels"`
		Candidates []ThinkingLevel `json:"candidates"`
		Supported  bool            `json:"supported"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			before, _ := json.Marshal(v.Levels)
			got := AdaptThinkingCandidates(v.Levels)
			if !reflect.DeepEqual(got, v.Candidates) {
				t.Fatalf("candidates = %+v, want %+v", got, v.Candidates)
			}
			if (len(got) >= 2) != v.Supported {
				t.Fatalf("support = %t, want %t", len(got) >= 2, v.Supported)
			}
			if len(got) > 0 {
				got[0].Value = "changed"
			}
			after, _ := json.Marshal(v.Levels)
			if string(before) != string(after) {
				t.Fatal("candidate filtering mutated the source catalog")
			}
		})
	}
}

func TestThinkingLevelAdaptIsReserved(t *testing.T) {
	if isValidDynamicThinkingValue(ThinkingLevelAdapt) {
		t.Fatal("adaptive mode must not be a CLI-native token")
	}
	for _, provider := range []string{"claude", "codex", "pi", "omp", "opencode", "deveco", "kimi", "dsh", "grok", "codebuddy", "reasonix", "hermes", "dim"} {
		if IsKnownThinkingValue(provider, ThinkingLevelAdapt) {
			t.Errorf("%s accepted adaptive mode as a native level", provider)
		}
	}
}

func TestModelAdaptThinkingCandidates(t *testing.T) {
	levels := []ThinkingLevel{{Value: "auto"}, {Value: "off"}, {Value: ThinkingLevelAdapt}, {Value: "high", Label: "High", Description: "CLI high"}, {Value: "low"}, {Value: "high"}, {Value: "custom"}}
	models := []Model{
		{ID: "claude-opus-5[1m]", Default: true, Thinking: &ModelThinking{SupportedLevels: levels}},
		{ID: "other", Thinking: &ModelThinking{SupportedLevels: []ThinkingLevel{{Value: "ultra"}, {Value: "max"}}}},
	}
	for _, tc := range []struct {
		name, provider, model string
		catalog               Catalog
		want                  []string
	}{
		{"tagged model", "claude", "claude-opus-5[2m]", Catalog{Models: models}, []string{"high", "low", "custom"}},
		{"default", "claude", "", Catalog{Models: models}, []string{"high", "low", "custom"}},
		{"binary intersection", "claude", "", Catalog{Models: models, CLIThinkingLevels: []string{"low", "high"}}, []string{"high", "low"}},
		{"no guessed opencode default", "opencode", "", Catalog{Models: models[1:]}, nil},
		{"no codex default", "codex", "", Catalog{Models: models}, nil},
		{"no omp default", "omp", "", Catalog{Models: models}, nil},
		// deveco: no default in its OpenCode-engine catalog, so an empty
		// model yields no candidates; a pinned model yields its own.
		{"no deveco default", "deveco", "", Catalog{Models: models}, nil},
		{"deveco pinned model", "deveco", "other", Catalog{Models: models}, []string{"ultra", "max"}},
		{"unsupported provider", "cursor", "other", Catalog{Models: models}, nil},
		{"fallback", "claude", "", Catalog{Models: models, Fallback: true}, nil},
		{"explicit", "codex", "other", Catalog{Models: models}, []string{"ultra", "max"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var values []string
			for _, candidate := range ModelAdaptThinkingCandidates(tc.catalog, tc.provider, tc.model) {
				values = append(values, candidate.Value)
				if candidate.Value == "high" && (candidate.Label != "High" || candidate.Description != "CLI high") {
					t.Fatal("lost catalog metadata")
				}
			}
			if !reflect.DeepEqual(values, tc.want) {
				t.Fatalf("got %v want %v", values, tc.want)
			}
		})
	}
}
