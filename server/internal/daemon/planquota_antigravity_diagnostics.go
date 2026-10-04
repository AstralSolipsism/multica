package daemon

import (
	"errors"
	"time"
)

// Stable health diagnostics describe the remote collector without exposing
// credentials, response bodies, or account metadata.
const (
	antigravityQuotaSkipNotRegistered = "not_registered"
	antigravityQuotaSkipNoVersion     = "no_version"
	antigravityQuotaSkipToken         = "oauth_token_unavailable"
	antigravityQuotaSkipAuth          = "authorization_rejected"
	antigravityQuotaSkipRateLimited   = "rate_limited"
	antigravityQuotaSkipFailed        = "collection_failed"
)

type antigravityQuotaDiagnostics struct {
	attemptAt  time.Time
	successAt  time.Time
	skipReason string
}

func (d *Daemon) recordAntigravityQuotaSkip(reason string) {
	d.antigravityQuotaDiagMu.Lock()
	defer d.antigravityQuotaDiagMu.Unlock()
	d.antigravityQuotaDiag.attemptAt = time.Now()
	d.antigravityQuotaDiag.skipReason = reason
}

func (d *Daemon) recordAntigravityQuotaSuccess() {
	d.antigravityQuotaDiagMu.Lock()
	defer d.antigravityQuotaDiagMu.Unlock()
	now := time.Now()
	d.antigravityQuotaDiag.attemptAt = now
	d.antigravityQuotaDiag.successAt = now
	d.antigravityQuotaDiag.skipReason = ""
}

func (d *Daemon) antigravityQuotaDiagSnapshot() *healthAntigravityQuota {
	d.antigravityQuotaDiagMu.Lock()
	defer d.antigravityQuotaDiagMu.Unlock()
	if d.antigravityQuotaDiag.attemptAt.IsZero() {
		return nil
	}
	out := &healthAntigravityQuota{
		LastAttemptAt:  d.antigravityQuotaDiag.attemptAt.UTC().Format(time.RFC3339),
		LastSkipReason: d.antigravityQuotaDiag.skipReason,
	}
	if !d.antigravityQuotaDiag.successAt.IsZero() {
		out.LastSuccessAt = d.antigravityQuotaDiag.successAt.UTC().Format(time.RFC3339)
	}
	return out
}

func antigravityQuotaSkipReasonFor(err error) string {
	var limited *rateLimitError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errAntigravityQuotaVersion):
		return antigravityQuotaSkipNoVersion
	case errors.Is(err, errAntigravityQuotaToken):
		return antigravityQuotaSkipToken
	case errors.Is(err, errAntigravityQuotaAuth):
		return antigravityQuotaSkipAuth
	case errors.As(err, &limited):
		return antigravityQuotaSkipRateLimited
	default:
		return antigravityQuotaSkipFailed
	}
}
