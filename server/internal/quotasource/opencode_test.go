package quotasource

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestNormalizeOpenCodeCookie(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{
			name: "bare session value expands to both cookies",
			raw:  "bare-session-value",
			want: "__Host-console_session=bare-session-value; auth=bare-session-value",
		},
		{
			name: "full cookie header keeps only the two session cookies",
			raw:  "__Host-console_session=abc; theme=dark; auth=xyz",
			want: "__Host-console_session=abc; auth=xyz",
		},
		{
			name: "legacy auth cookie only",
			raw:  "auth=legacy-value",
			want: "auth=legacy-value",
		},
		{
			name:    "empty rejected",
			raw:     "   ",
			wantErr: true,
		},
		{
			name:    "unrelated cookie rejected",
			raw:     "theme=dark",
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeOpenCodeCookie(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("cookie = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseOpenCodeWorkspaceID(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{name: "workspace id", raw: "wrk_abc-123", want: "wrk_abc-123"},
		{name: "org id", raw: "org_x1", want: "org_x1"},
		{name: "console billing url", raw: "https://opencode.ai/workspace/wrk_live/billing", want: "wrk_live"},
		{name: "console url without scheme", raw: "opencode.ai/console/org_live", want: "org_live"},
		{name: "invalid", raw: "not a workspace", wantErr: true},
		{name: "valid-looking path without a known id", raw: "https://opencode.ai/workspace/abc/billing", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseOpenCodeWorkspaceID(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("workspace id = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestOpenCodeCredentialEnvelope(t *testing.T) {
	encoded := EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "wrk_abc", "__Host-console_session=secret")
	cred := ParseOpenCodeCredential(encoded)
	if cred.Mode != OpenCodeModePayAsYouGo || cred.WorkspaceID != "wrk_abc" || cred.Secret != "__Host-console_session=secret" {
		t.Fatalf("envelope round trip = %+v", cred)
	}

	// Go mode never persists a workspace id: a Zen key cannot address one.
	goCred := ParseOpenCodeCredential(EncodeOpenCodeCredential(OpenCodeModeGo, "wrk_abc", "zen-key"))
	if goCred.Mode != OpenCodeModeGo || goCred.WorkspaceID != "" || goCred.Secret != "zen-key" {
		t.Fatalf("go envelope = %+v", goCred)
	}

	// Legacy rows store the bare Zen API key.
	legacy := ParseOpenCodeCredential("sk-legacy-zen-key")
	if legacy.Mode != OpenCodeModeGo || legacy.Secret != "sk-legacy-zen-key" {
		t.Fatalf("legacy credential = %+v", legacy)
	}
}

func TestOpenCodePayAsYouGoFetch(t *testing.T) {
	const workspaceID = "wrk_discovered"
	var (
		gotCookie   string
		gotOrgID    string
		orgHits     int
		summaryHits int
	)
	credential := EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "", "bare-cookie-value")
	quota, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/console/api/orgs":
			orgHits++
			gotCookie = r.Header.Get("Cookie")
			_, _ = io.WriteString(w, `{"data":[{"id":"`+workspaceID+`"},{"id":"wrk_other"}]}`)
		case "/console/api/billing/status":
			gotOrgID = r.Header.Get("x-org-id")
			_, _ = io.WriteString(w, `{"balanceMicroCents":"2787000000"}`)
		case "/console/api/usage/summary":
			summaryHits++
			if r.URL.Query().Get("range") != "30d" {
				t.Errorf("usage range = %q", r.URL.Query().Get("range"))
			}
			_, _ = io.WriteString(w, `{"totalCostMicroCents":"1420000000"}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}, credential)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if orgHits != 1 || summaryHits != 1 {
		t.Fatalf("orgs hits = %d, summary hits = %d", orgHits, summaryHits)
	}
	if !strings.Contains(gotCookie, "__Host-console_session=bare-cookie-value") || !strings.Contains(gotCookie, "auth=bare-cookie-value") {
		t.Fatalf("cookie header = %q", gotCookie)
	}
	if gotOrgID != workspaceID {
		t.Fatalf("x-org-id = %q, want %q", gotOrgID, workspaceID)
	}
	if quota.Provider != "opencode" || quota.Status != protocol.PlanQuotaStatusOK {
		t.Fatalf("provider/status = %s/%s", quota.Provider, quota.Status)
	}
	if quota.Available == nil || !*quota.Available {
		t.Fatalf("available = %v", quota.Available)
	}
	if len(quota.Balances) != 1 {
		t.Fatalf("balances = %+v", quota.Balances)
	}
	balance := quota.Balances[0]
	if balance.Currency != "USD" || balance.TotalBalance == nil || *balance.TotalBalance != 27.87 {
		t.Fatalf("balance = %+v", balance)
	}
	if balance.Spend30d == nil || *balance.Spend30d != 14.2 {
		t.Fatalf("spend_30d = %v", balance.Spend30d)
	}
	if len(quota.Windows) != 0 {
		t.Fatalf("pay-as-you-go snapshot must not carry subscription windows: %+v", quota.Windows)
	}
}

func TestOpenCodePayAsYouGoZeroBalanceIsLimited(t *testing.T) {
	quota, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/console/api/billing/status":
			_, _ = io.WriteString(w, `{"balanceMicroCents":"0"}`)
		case "/console/api/usage/summary":
			// The auxiliary request failing must not fail the collection.
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}, EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "wrk_abc", "__Host-console_session=abc"))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	// Exact zero is a real, exhausted balance: `> 0` must stay strict.
	if quota.Status != protocol.PlanQuotaStatusLimited || quota.Available == nil || *quota.Available {
		t.Fatalf("status/available = %s/%v", quota.Status, quota.Available)
	}
	if len(quota.Balances) != 1 || quota.Balances[0].TotalBalance == nil || *quota.Balances[0].TotalBalance != 0 {
		t.Fatalf("balance = %+v, want a preserved 0", quota.Balances)
	}
	if quota.Balances[0].Spend30d != nil {
		t.Fatalf("failed usage summary must not fabricate spend: %v", *quota.Balances[0].Spend30d)
	}
}

func TestOpenCodePayAsYouGoNegativeBalanceIsPreserved(t *testing.T) {
	quota, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/console/api/billing/status":
			_, _ = io.WriteString(w, `{"balanceMicroCents":-25000000}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}, EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "wrk_abc", "__Host-console_session=abc"))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if quota.Status != protocol.PlanQuotaStatusLimited || quota.Available == nil || *quota.Available {
		t.Fatalf("status/available = %s/%v", quota.Status, quota.Available)
	}
	if len(quota.Balances) != 1 || quota.Balances[0].TotalBalance == nil || *quota.Balances[0].TotalBalance != -0.25 {
		t.Fatalf("balance = %+v, want -0.25 preserved", quota.Balances)
	}
}

func TestOpenCodePayAsYouGoZeroSpendIsKept(t *testing.T) {
	quota, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/console/api/billing/status":
			_, _ = io.WriteString(w, `{"balanceMicroCents":"100000000"}`)
		case "/console/api/usage/summary":
			_, _ = io.WriteString(w, `{"totalCostMicroCents":"0"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}, EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "wrk_abc", "__Host-console_session=abc"))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(quota.Balances) != 1 {
		t.Fatalf("balances = %+v", quota.Balances)
	}
	// Zero spend is a real value, not "missing".
	if quota.Balances[0].Spend30d == nil || *quota.Balances[0].Spend30d != 0 {
		t.Fatalf("spend_30d = %v, want a preserved 0", quota.Balances[0].Spend30d)
	}
}

func TestOpenCodePayAsYouGoConfiguredWorkspaceSkipsDiscovery(t *testing.T) {
	var paths []string
	_, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/console/api/orgs" {
			t.Error("configured workspace must not trigger org discovery")
		}
		if r.Header.Get("Cookie") != "__Host-console_session=abc; auth=def" {
			t.Errorf("cookie = %q", r.Header.Get("Cookie"))
		}
		if r.Header.Get("x-org-id") != "org_from_url" {
			t.Errorf("x-org-id = %q", r.Header.Get("x-org-id"))
		}
		_, _ = io.WriteString(w, `{"balanceMicroCents":"100000000"}`)
	}, EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "https://opencode.ai/console/org_from_url", "__Host-console_session=abc; auth=def"))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	for _, path := range paths {
		if path == "/console/api/orgs" {
			t.Fatal("discovery request was sent")
		}
	}
}

func TestOpenCodePayAsYouGoErrorMapping(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{status: http.StatusUnauthorized, want: "invalid_credential"},
		{status: http.StatusForbidden, want: "invalid_credential"},
		{status: http.StatusTooManyRequests, want: "rate_limited"},
		{status: http.StatusInternalServerError, want: "provider_error"},
	}
	for _, tc := range cases {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			_, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/console/api/orgs" {
					_, _ = io.WriteString(w, `[{"id":"wrk_abc"}]`)
					return
				}
				w.WriteHeader(tc.status)
			}, EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "wrk_abc", "cookie-value"))
			if err == nil || ClassifyError(err) != tc.want {
				t.Fatalf("error = %v, want code %q", err, tc.want)
			}
		})
	}
}

func TestOpenCodePayAsYouGoHTMLLoginPageMapsToInvalidCredential(t *testing.T) {
	_, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/console/api/orgs" {
			_, _ = io.WriteString(w, `[{"id":"wrk_abc"}]`)
			return
		}
		_, _ = io.WriteString(w, `<html><body>Sign in to continue</body></html>`)
	}, EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "wrk_abc", "expired-cookie"))
	if err == nil || ClassifyError(err) != "invalid_credential" {
		t.Fatalf("error = %v, want invalid_credential", err)
	}
}

func TestOpenCodePayAsYouGoLegacyServerFallback(t *testing.T) {
	credential := EncodeOpenCodeCredential(OpenCodeModePayAsYouGo, "", "legacy-cookie-value")
	var billingArgs string
	var billingCookie string
	quota, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/console/api/orgs":
			http.NotFound(w, r)
		case r.URL.Path == "/console/api/billing/status":
			w.WriteHeader(http.StatusNotFound)
		case r.URL.Path == "/_server" && r.URL.Query().Get("id") == openCodeLegacyOrgsServerID:
			_, _ = io.WriteString(w, `[{"id":"wrk_legacy"}]`)
		case r.URL.Path == "/_server" && r.URL.Query().Get("id") == openCodeLegacyBillingServerID:
			billingArgs = r.URL.Query().Get("args")
			billingCookie = r.Header.Get("Cookie")
			if !strings.HasPrefix(r.Header.Get("X-Server-Instance"), "server-fn:") {
				t.Errorf("X-Server-Instance = %q", r.Header.Get("X-Server-Instance"))
			}
			_, _ = io.WriteString(w, `{"result":{"balance":"1000000000","monthlyUsage":"250000000"}}`)
		default:
			t.Errorf("unexpected url %s", r.URL.String())
		}
	}, credential)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if billingArgs != `["wrk_legacy"]` {
		t.Fatalf("args = %q", billingArgs)
	}
	if !strings.Contains(billingCookie, "legacy-cookie-value") {
		t.Fatalf("cookie = %q", billingCookie)
	}
	if len(quota.Balances) != 1 {
		t.Fatalf("balances = %+v", quota.Balances)
	}
	balance := quota.Balances[0]
	if balance.TotalBalance == nil || *balance.TotalBalance != 10 {
		t.Fatalf("balance = %v", balance.TotalBalance)
	}
	if balance.Spend30d == nil || *balance.Spend30d != 2.5 {
		t.Fatalf("spend_30d = %v", balance.Spend30d)
	}
}

func TestOpenCodeGoModeUsesZenUsage(t *testing.T) {
	quota, err := fetchWith(t, OpenCodeDriver{}, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/zen/go/v1/usage" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-zen-key" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(w, `{"usage":{"rolling":{"status":"ok","percent":18,"resetsAt":"2026-11-18T12:00:00Z"},"weekly":{"status":"ok","percent":36},"monthly":{"status":"rate-limited","percent":100}}}`)
	}, EncodeOpenCodeCredential(OpenCodeModeGo, "", "sk-zen-key"))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if quota.Status != protocol.PlanQuotaStatusLimited {
		t.Fatalf("status = %s", quota.Status)
	}
	if *windowUsed(t, quota, "opencode_5h") != 18 {
		t.Fatalf("5h window = %v", quota.Windows)
	}
}

// windowUsed returns the used percent of the named window.
func windowUsed(t *testing.T, quota *protocol.QuotaSourceSnapshot, name string) *float64 {
	t.Helper()
	for _, w := range quota.Windows {
		if w.Name == name {
			return w.UsedPercent
		}
	}
	t.Fatalf("window %q missing from %+v", name, quota.Windows)
	return nil
}

// Ensure the encoded credential never leaks into JSON snapshots.
func TestOpenCodePaygSnapshotCarriesNoCredential(t *testing.T) {
	quota := openCodePaygSnapshot(openCodeBillingFigures{balanceMicro: 100000000}, time.Unix(1_800_000_000, 0))
	body, err := json.Marshal(quota)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "cookie") || strings.Contains(string(body), "secret") {
		t.Fatalf("snapshot leaked credential material: %s", body)
	}
}

func TestDefaultName(t *testing.T) {
	cases := map[string]string{
		"glm":      "GLM",
		"zenmux":   "ZenMux",
		"deepseek": "DeepSeek",
		"opencode": "OpenCode",
		"jev_free": "Jev Free",
	}
	for kind, want := range cases {
		if got := DefaultName(kind); got != want {
			t.Errorf("DefaultName(%q) = %q, want %q", kind, got, want)
		}
	}
}

func TestNormalizeOpenCodeMode(t *testing.T) {
	cases := map[string]string{
		"":       OpenCodeModeGo,
		"go":     OpenCodeModeGo,
		"payg":   OpenCodeModePayAsYouGo,
		" payg ": OpenCodeModePayAsYouGo,
	}
	for raw, want := range cases {
		got, ok := NormalizeOpenCodeMode(raw)
		if !ok || got != want {
			t.Errorf("NormalizeOpenCodeMode(%q) = %q/%v, want %q", raw, got, ok, want)
		}
	}
	if _, ok := NormalizeOpenCodeMode("other"); ok {
		t.Error("unknown mode must be rejected")
	}
}
