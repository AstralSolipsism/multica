package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// The documented example payload, with all the account/billing fields the
// snapshot must NOT carry.
const zenmuxDetailJSON = `{
  "success": true,
  "data": {
    "plan": {"tier": "ultra", "amount_usd": 200, "interval": "month", "expires_at": "2026-04-12T08:26:56.000Z"},
    "currency": "usd",
    "base_usd_per_flow": 0.03283,
    "effective_usd_per_flow": 0.03283,
    "account_status": "healthy",
    "quota_5_hour": {
      "usage_percentage": 0.0715,
      "resets_at": "2026-03-24T08:35:09.000Z",
      "max_flows": 800,
      "used_flows": 57.2,
      "remaining_flows": 742.8,
      "used_value_usd": 1.88,
      "max_value_usd": 26.27
    },
    "quota_7_day": {
      "usage_percentage": 0.0673,
      "resets_at": "2026-03-26T02:15:05.000Z",
      "max_flows": 6182,
      "used_flows": 416.11,
      "remaining_flows": 5765.89,
      "used_value_usd": 13.66,
      "max_value_usd": 202.99
    },
    "quota_monthly": {"max_flows": 34560, "max_value_usd": 1134.33}
  }
}`

func newZenmuxTestServer(t *testing.T, status int, body string, gotAuth *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = w.Write([]byte(body))
	}))
}

func TestZenmuxCollect_Success(t *testing.T) {
	var gotAuth string
	srv := newZenmuxTestServer(t, 0, zenmuxDetailJSON, &gotAuth)
	defer srv.Close()

	collector := newZenmuxPlanQuotaCollector(srv.URL, "zm-mgmt-key")
	quota, err := collector.collect(context.Background())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if gotAuth != "Bearer zm-mgmt-key" {
		t.Fatalf("authorization header = %q", gotAuth)
	}
	if quota.Provider != "zenmux" || quota.Source != protocol.PlanQuotaSourceDaemon || quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("identity fields = %+v", quota)
	}
	if len(quota.Windows) != 2 {
		t.Fatalf("windows = %+v", quota.Windows)
	}
	primary := quota.Windows[0]
	if primary.Name != "primary" || *primary.WindowMinutes != 300 {
		t.Fatalf("primary = %+v", primary)
	}
	if diff := *primary.UsedPercent - 7.15; diff < -0.001 || diff > 0.001 {
		t.Fatalf("primary used_percent = %v", *primary.UsedPercent)
	}
	wantReset := time.Date(2026, 3, 24, 8, 35, 9, 0, time.UTC).Unix()
	if primary.ResetsAt == nil || *primary.ResetsAt != wantReset {
		t.Fatalf("primary resets_at = %v", primary.ResetsAt)
	}
	secondary := quota.Windows[1]
	if secondary.Name != "secondary" || *secondary.WindowMinutes != 10080 {
		t.Fatalf("secondary = %+v", secondary)
	}
	if diff := *secondary.UsedPercent - 6.73; diff < -0.001 || diff > 0.001 {
		t.Fatalf("secondary used_percent = %v", *secondary.UsedPercent)
	}
}

// The snapshot must not carry the key, the plan tier, account status, or any
// USD/flow figure — only coarse percentages and window metadata.
func TestZenmuxCollect_RedLine(t *testing.T) {
	var gotAuth string
	srv := newZenmuxTestServer(t, 0, zenmuxDetailJSON, &gotAuth)
	defer srv.Close()

	collector := newZenmuxPlanQuotaCollector(srv.URL, "zm-mgmt-key")
	quota, err := collector.collect(context.Background())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	raw, err := json.Marshal(quota)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"zm-mgmt-key", "ultra", "tier", "usd", "flow", "healthy", "0.03283"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("snapshot leaks %q: %s", forbidden, raw)
		}
	}
}

func TestZenmuxCollect_RateLimited(t *testing.T) {
	var gotAuth string
	srv := newZenmuxTestServer(t, http.StatusUnprocessableEntity, `{"success":false,"error":"rate limit exceeded"}`, &gotAuth)
	defer srv.Close()

	collector := newZenmuxPlanQuotaCollector(srv.URL, "k")
	_, err := collector.collect(context.Background())
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	var rl *rateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("err type = %T, want *rateLimitError", err)
	}
}

func TestZenmuxCollect_Failures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"http 500", http.StatusInternalServerError, `{"success":false}`},
		{"success false", 0, `{"success":false}`},
		{"malformed", 0, `not json`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotAuth string
			srv := newZenmuxTestServer(t, tc.status, tc.body, &gotAuth)
			defer srv.Close()
			collector := newZenmuxPlanQuotaCollector(srv.URL, "k")
			if _, err := collector.collect(context.Background()); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestZenmuxDetailToPlanQuota_Mapping(t *testing.T) {
	observed := time.Unix(1757000000, 0)
	t.Run("limited at full usage", func(t *testing.T) {
		data := &zenmuxSubscriptionData{
			Quota5Hour: &zenmuxQuotaWindow{UsagePercentage: f64(1.0)},
		}
		quota := zenmuxDetailToPlanQuota(data, observed)
		if quota.Status != protocol.PlanQuotaStatusLimited {
			t.Fatalf("status = %q", quota.Status)
		}
	})

	t.Run("null resets_at stays undisclosed", func(t *testing.T) {
		data := &zenmuxSubscriptionData{
			Quota5Hour: &zenmuxQuotaWindow{UsagePercentage: f64(0.5), ResetsAt: nil},
		}
		quota := zenmuxDetailToPlanQuota(data, observed)
		if quota.Windows[0].ResetsAt != nil {
			t.Fatalf("resets_at = %v", *quota.Windows[0].ResetsAt)
		}
	})

	t.Run("single window survives, empty is nil", func(t *testing.T) {
		data := &zenmuxSubscriptionData{
			Quota7Day: &zenmuxQuotaWindow{UsagePercentage: f64(0.1)},
		}
		quota := zenmuxDetailToPlanQuota(data, observed)
		if quota == nil || len(quota.Windows) != 1 || quota.Windows[0].Name != "secondary" {
			t.Fatalf("quota = %+v", quota)
		}
		if got := zenmuxDetailToPlanQuota(&zenmuxSubscriptionData{}, observed); got != nil {
			t.Fatalf("empty = %+v", got)
		}
		if got := zenmuxDetailToPlanQuota(nil, observed); got != nil {
			t.Fatalf("nil = %+v", got)
		}
	})

	t.Run("zero percent preserved", func(t *testing.T) {
		data := &zenmuxSubscriptionData{
			Quota5Hour: &zenmuxQuotaWindow{UsagePercentage: f64(0)},
		}
		quota := zenmuxDetailToPlanQuota(data, observed)
		if quota.Windows[0].UsedPercent == nil || *quota.Windows[0].UsedPercent != 0 {
			t.Fatalf("zero percent lost: %+v", quota.Windows[0])
		}
	})
}
