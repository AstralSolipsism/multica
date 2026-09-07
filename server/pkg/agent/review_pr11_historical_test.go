package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReviewPR11ResumedHistoricalQuotaIsNotFresh(t *testing.T) {
	startTime := time.Now().Add(-time.Minute)
	oldObservedAt := startTime.Add(-48 * time.Hour)
	for _, position := range []string{"sibling", "legacy"} {
		t.Run(position, func(t *testing.T) {
			taskHome := t.TempDir()
			threadID := "review-historical-thread"
			quota := fmt.Sprintf(`{"secondary":{"used_percent":7,"window_minutes":10080,"resets_at":%d}}`, startTime.Add(24*time.Hour).Unix())
			info := `"total_token_usage":{"input_tokens":600,"output_tokens":30}`
			var payload string
			if position == "legacy" {
				payload = `{"type":"token_count","info":{` + info + `,"rate_limits":` + quota + `}}`
			} else {
				payload = `{"type":"token_count","info":{` + info + `},"rate_limits":` + quota + `}`
			}
			content := strings.Join([]string{
				fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":%s}`, oldObservedAt.UTC().Format(time.RFC3339Nano), payload),
				fmt.Sprintf(`{"timestamp":%q,"type":"turn_context","payload":{"model":"gpt-test"}}`, startTime.Add(time.Second).UTC().Format(time.RFC3339Nano)),
				"",
			}, "\n")
			path := filepath.Join(taskHome, "sessions", "rollout-review-"+threadID+".jsonl")
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(path, startTime.Add(time.Second), startTime.Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			for _, entry := range []string{"parse", "scan"} {
				t.Run(entry, func(t *testing.T) {
					var got *codexSessionUsage
					if entry == "parse" {
						got = parseCodexSessionFileSince(path, startTime, true)
					} else {
						got = scanCodexSessionUsage(startTime, taskHome, threadID, true)
					}
					if got == nil || got.rateLimits == nil {
						return
					}
					q := codexRateLimitsToPlanQuota(got.rateLimits, startTime.Add(2*time.Second))
					if q != nil && q.ObservedAt > oldObservedAt.Unix() {
						t.Fatalf("48h-old quota returned as fresh: source observed=%d, result observed=%d, usage=%+v", oldObservedAt.Unix(), q.ObservedAt, got.usage)
					}
				})
			}
		})
	}
}
