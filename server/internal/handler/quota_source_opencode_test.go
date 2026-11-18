package handler

import (
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/quotasource"
)

func TestCredentialHintUsesSecretTail(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "long key", raw: "sk-1234567890abcdef", want: "cdef"},
		{name: "short key never hinted", raw: "short", want: ""},
		{name: "cookie header keeps the value tail", raw: "__Host-console_session=abc123; auth=xyz9", want: "xyz9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := credentialHint(tc.raw); got != tc.want {
				t.Fatalf("credentialHint(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// The envelope stores mode/workspace around the real secret; the displayed
// mask must come from the secret, never the JSON tail.
func TestOpenCodeEnvelopeHintDoesNotMaskEnvelopeJSON(t *testing.T) {
	secret := "cookie-value-abcdef"
	envelope := quotasource.EncodeOpenCodeCredential(quotasource.OpenCodeModePayAsYouGo, "wrk_abc", secret)
	parsed := quotasource.ParseOpenCodeCredential(envelope)
	if got := credentialHint(parsed.Secret); got != "cdef" {
		t.Fatalf("hint from unsealed secret = %q, want cdef", got)
	}
	if strings.HasSuffix(envelope, "cdef") {
		t.Fatalf("envelope unexpectedly ends with the secret tail: %s", envelope)
	}
}

func TestNormalizedOpenCodeWorkspace(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{name: "empty means discovery", raw: "  ", want: ""},
		{name: "id passes through", raw: "wrk_abc", want: "wrk_abc"},
		{name: "console url extracts id", raw: "https://opencode.ai/workspace/wrk_live/billing", want: "wrk_live"},
		{name: "invalid rejected", raw: "not-an-id", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizedOpenCodeWorkspace(tc.raw)
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
				t.Fatalf("workspace = %q, want %q", got, tc.want)
			}
		})
	}
}

// A pay-as-you-go credential is a Cookie header; the displayed mask must be
// the core session value's tail, never an unrelated cookie or punctuation.
func TestQuotaSourceCredentialHintOpenCodeCookieBoundaries(t *testing.T) {
	cases := []struct {
		name       string
		kind       string
		mode       string
		credential string
		want       string
	}{
		{
			name:       "bare session value",
			kind:       "opencode",
			mode:       "payg",
			credential: "session-value-1234",
			want:       "1234",
		},
		{
			name:       "full header ignores unrelated cookie",
			kind:       "opencode",
			mode:       "payg",
			credential: "__Host-console_session=session-value-1234; theme=dark",
			want:       "1234",
		},
		{
			name:       "trailing semicolon does not leak punctuation",
			kind:       "opencode",
			mode:       "payg",
			credential: "__Host-console_session=session-value-1234; theme=dark;",
			want:       "1234",
		},
		{
			name:       "legacy auth cookie is the fallback",
			kind:       "opencode",
			mode:       "payg",
			credential: "theme=dark; auth=legacy-value-9876",
			want:       "9876",
		},
		{
			name:       "primary cookie wins when both are present",
			kind:       "opencode",
			mode:       "payg",
			credential: "__Host-console_session=primary-value-1234; auth=secondary-value-9876",
			want:       "1234",
		},
		{
			name:       "short session value stays hidden despite long header",
			kind:       "opencode",
			mode:       "payg",
			credential: "__Host-console_session=abc; theme=some-long-cookie-value",
			want:       "",
		},
		{
			name:       "header with no session cookie never hints",
			kind:       "opencode",
			mode:       "payg",
			credential: "theme=some-long-cookie-value",
			want:       "",
		},
		{
			name:       "go mode masks the zen api key",
			kind:       "opencode",
			mode:       "go",
			credential: "sk-zen-key-123456",
			want:       "3456",
		},
		{
			name:       "non-opencode kinds keep the raw key mask",
			kind:       "deepseek",
			mode:       "",
			credential: "sk-deepseek-key-123456",
			want:       "3456",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := quotaSourceCredentialHint(tc.kind, tc.mode, tc.credential); got != tc.want {
				t.Fatalf("hint = %q, want %q", got, tc.want)
			}
		})
	}
}
