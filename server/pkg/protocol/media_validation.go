package protocol

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"time"

	"github.com/google/uuid"
)

func MediaCapability(provider string) string {
	switch provider {
	case "codex":
		return MediaImageCodexV1
	case "agy":
		return MediaImageAGYV1
	case "flow":
		return MediaVideoFlowV1
	case "whisk":
		return MediaImageWhiskV1
	default:
		return ""
	}
}
func IsMediaCapability(capability string) bool {
	return slices.Contains([]string{MediaImageCodexV1, MediaImageAGYV1, MediaVideoFlowV1, MediaImageWhiskV1}, capability)
}

// Transport capabilities are machine-wide. Native media capabilities may only
// be derived from validated instance reports, never copied from HTTP headers.
func WithoutMediaCapabilities(capabilities []string) []string {
	out := make([]string, 0, len(capabilities))
	for _, c := range capabilities {
		if !IsMediaCapability(c) {
			out = append(out, c)
		}
	}
	return out
}

var mediaLabel = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,95}$`)

func ValidateMediaExecutorReport(report *MediaExecutorReport, now time.Time) error {
	if report == nil {
		return nil
	}
	if err := mediaUUID(report.ConnectionID); err != nil {
		return fmt.Errorf("invalid media connection_id")
	}
	if len(report.Executors) > MediaMaxExecutors {
		return fmt.Errorf("too many media executors")
	}
	seen := make(map[string]bool)
	for _, e := range report.Executors {
		if err := mediaUUID(e.ExecutorID); err != nil {
			return fmt.Errorf("invalid executor_id")
		}
		if seen[e.ExecutorID] {
			return fmt.Errorf("duplicate executor_id")
		}
		seen[e.ExecutorID] = true
		if mediaUUID(e.CredentialScopeID) != nil || mediaUUID(e.QuotaRef.ScopeID) != nil {
			return fmt.Errorf("invalid media scope identity")
		}
		if e.DescriptorVersion != MediaDescriptorVersion {
			return fmt.Errorf("unsupported media descriptor version")
		}
		if MediaCapability(e.Provider) == "" || MediaCapability(e.Provider) != e.Capability {
			return fmt.Errorf("media provider/capability mismatch")
		}
		resolved := e.Provider
		if resolved == "whisk" {
			resolved = "flow"
		}
		if e.ResolvedProvider != resolved {
			return fmt.Errorf("incorrect resolved_provider")
		}
		if !slices.Contains([]MediaReadiness{MediaReady, MediaNeedsAuth, MediaUnsupported, MediaUnhealthy}, e.Readiness) {
			return fmt.Errorf("invalid media readiness")
		}
		if e.ObservedAt <= 0 || e.ObservedAt > now.Add(5*time.Minute).Unix() || e.ObservedAt < now.Add(-10*time.Minute).Unix() {
			return fmt.Errorf("stale or future media observation")
		}
		if e.MaxConcurrency < 1 || e.MaxConcurrency > 64 {
			return fmt.Errorf("invalid media max_concurrency")
		}
		if e.ReasonCode != "" && !mediaLabel.MatchString(e.ReasonCode) {
			return fmt.Errorf("invalid media reason_code")
		}
		if len(e.Models) > 16 || len(e.InputRoles) > 16 || len(e.OutputFormats) > 8 {
			return fmt.Errorf("media descriptor too large")
		}
		for _, labels := range [][]string{e.Models, e.InputRoles, e.OutputFormats} {
			for _, label := range labels {
				if !mediaLabel.MatchString(label) {
					return fmt.Errorf("invalid media descriptor label")
				}
			}
		}
		if e.Readiness == MediaReady {
			if len(e.Models) == 0 || len(e.OutputFormats) == 0 {
				return fmt.Errorf("ready executor requires verified models and formats")
			}
			if e.Provider == "whisk" {
				for _, role := range []string{"subject", "scene", "style"} {
					if !slices.Contains(e.InputRoles, role) {
						return fmt.Errorf("whisk requires subject/scene/style roles")
					}
				}
			}
		}
		if e.QuotaRef.RuntimeID != "" && mediaUUID(e.QuotaRef.RuntimeID) != nil {
			return fmt.Errorf("invalid quota runtime_id")
		}
		if len(e.QuotaRef.Windows) > PlanQuotaMaxWindows {
			return fmt.Errorf("too many media quota windows")
		}
		for _, w := range e.QuotaRef.Windows {
			if !mediaLabel.MatchString(w.Name) || (w.Group != "" && !mediaLabel.MatchString(w.Group)) {
				return fmt.Errorf("invalid quota window reference")
			}
		}
		if e.PlanQuota != nil {
			if e.PlanQuota.Provider != e.ResolvedProvider && !(e.Provider == "agy" && e.PlanQuota.Provider == "antigravity") {
				return fmt.Errorf("media quota provider mismatch")
			}
			if e.QuotaRef.RuntimeID != "" || len(e.QuotaRef.Windows) == 0 {
				return fmt.Errorf("executor quota requires local verified windows")
			}
			if err := ValidateRuntimePlanQuota(e.PlanQuota, now); err != nil {
				return fmt.Errorf("invalid media quota: %w", err)
			}
			for _, ref := range e.QuotaRef.Windows {
				if !slices.ContainsFunc(e.PlanQuota.Windows, func(w RuntimePlanQuotaWindow) bool { return w.Name == ref.Name && w.Group == ref.Group }) {
					return fmt.Errorf("missing referenced quota window")
				}
			}
		}
	}
	return nil
}

func mediaUUID(s string) error {
	id, err := uuid.Parse(s)
	if err != nil || id == uuid.Nil || id.String() != s {
		return fmt.Errorf("noncanonical UUID")
	}
	return nil
}

// MarshalMediaControl applies the v1 size ceiling before enqueueing a frame.
// Callers must pass one of the typed control messages, not HTTP manifests.
func MarshalMediaControl(v any) ([]byte, error) {
	switch v.(type) {
	case MediaAvailablePayload, MediaClaimRequest, MediaClaimResponse, MediaStartRequest, MediaProgressRequest, MediaProducedRequest, MediaFailRequest, MediaReconcileRequest, MediaReconcileResponse, MediaAttemptReceipt:
	default:
		return nil, fmt.Errorf("unsupported media control message")
	}
	b, err := json.Marshal(v)
	if err == nil && len(b) > MediaControlMaxBytes {
		return nil, fmt.Errorf("media control frame exceeds %d bytes", MediaControlMaxBytes)
	}
	return b, err
}
