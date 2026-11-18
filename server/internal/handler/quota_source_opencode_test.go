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
