package agent

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestCodexPlanQuotaHeartbeatContract(t *testing.T) {
	at := time.Unix(1800000000, 0)
	for _, body := range []string{
		`{"primary":{"used_percent":0,"window_minutes":300,"resets_at":1800003600},"secondary":{"used_percent":62,"window_minutes":10080}}`,
		`{"primary":{"used_percent":100,"window_minutes":300}}`,
		`{"secondary":{"used_percent":110,"window_minutes":10080}}`,
		`{"primary":{"resets_at":1800003600}}`,
	} {
		t.Run(body, func(t *testing.T) {
			var raw codexRawRateLimits
			if err := json.Unmarshal([]byte(body), &raw); err != nil {
				t.Fatal(err)
			}
			q := codexRateLimitsToPlanQuota(&raw, at)
			if q == nil || len(q.Windows) == 0 {
				t.Fatal("missing task quota snapshot")
			}
			if err := protocol.ValidateRuntimePlanQuota(q, at); err != nil {
				t.Fatalf("Codex violates heartbeat contract: %v", err)
			}
		})
	}
}
