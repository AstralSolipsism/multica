package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestCodexResultAccountingPreservesIndependentSignals(t *testing.T) {
	liveUsage := TokenUsage{InputTokens: 321, OutputTokens: 42, CacheReadTokens: 1000}
	for _, tc := range []struct {
		name, model          string
		liveUsage, wantUsage TokenUsage
		liveQuota            bool
		usageJSON            string
	}{
		{"default model with live usage and quota", "", liveUsage, liveUsage, true, ""},
		{"known model with missing quota", "configured", liveUsage, liveUsage, false, `,"info":{"total_token_usage":{"input_tokens":999,"output_tokens":999}}`},
		{"quota before first completed turn", "", TokenUsage{}, TokenUsage{}, false, ""},
		{"session usage fallback", "", TokenUsage{}, TokenUsage{InputTokens: 99, OutputTokens: 9}, false, `,"info":{"total_token_usage":{"input_tokens":99,"output_tokens":9}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			start := time.Now().Add(-time.Minute)
			dir := filepath.Join(home, "sessions")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			content := fmt.Sprintf(`{"timestamp":%q,"type":"turn_context","payload":{"model":"session-model"}}`+"\n"+
				`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":100,"window_minutes":300}}%s}}`+"\n",
				start.Add(time.Second).Format(time.RFC3339Nano), start.Add(2*time.Second).Format(time.RFC3339Nano), tc.usageJSON)
			if err := os.WriteFile(filepath.Join(dir, "rollout-2026-10-23T00-00-00-accounting.jsonl"), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			var live *codexRawRateLimits
			if tc.liveQuota {
				percent := float64(20)
				live = &codexRawRateLimits{Primary: &codexRawRateLimitWindow{UsedPercent: &percent}}
			}
			got, scanned := codexResultUsageMap(start, home, "accounting", false, tc.model, tc.liveUsage, live)
			if scanned == nil || scanned.Primary == nil || scanned.Primary.UsedPercent == nil || *scanned.Primary.UsedPercent != 100 {
				t.Fatalf("lost scanned quota: %+v", scanned)
			}
			if tc.wantUsage == (TokenUsage{}) {
				if got != nil {
					t.Fatalf("quota-only result fabricated usage: %+v", got)
				}
				return
			}
			model := tc.model
			if model == "" {
				model = "session-model"
			}
			if want := map[string]TokenUsage{model: tc.wantUsage}; !reflect.DeepEqual(got, want) {
				t.Fatalf("usage = %+v, want %+v", got, want)
			}
		})
	}
}
