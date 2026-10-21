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
	for _, provider := range []string{"claude", "codex", "pi", "omp", "opencode", "kimi", "dsh", "grok", "codebuddy", "reasonix", "hermes", "dim"} {
		if IsKnownThinkingValue(provider, ThinkingLevelAdapt) {
			t.Errorf("%s accepted adaptive mode as a native level", provider)
		}
	}
}
