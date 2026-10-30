package protocol

import (
	"github.com/google/uuid"
	"strings"
	"testing"
	"time"
)

func validMediaReport() *MediaExecutorReport {
	return &MediaExecutorReport{ConnectionID: uuid.NewString(), Executors: []MediaExecutorDescriptor{{ExecutorID: uuid.NewString(), CredentialScopeID: uuid.NewString(), Provider: "codex", ResolvedProvider: "codex", Capability: MediaImageCodexV1, DescriptorVersion: 1, Readiness: MediaReady, ObservedAt: time.Now().Unix(), MaxConcurrency: 1, Models: []string{"fixture-image-model"}, OutputFormats: []string{"png"}, QuotaRef: MediaQuotaRef{ScopeID: uuid.NewString()}}}}
}
func TestMediaDescriptorRejectsFalseCapabilities(t *testing.T) {
	cases := []struct {
		name   string
		change func(*MediaExecutorReport)
	}{
		{"wrong provider", func(r *MediaExecutorReport) { r.Executors[0].Capability = MediaImageAGYV1 }},
		{"missing model", func(r *MediaExecutorReport) { r.Executors[0].Models = nil }},
		{"credential id is not random", func(r *MediaExecutorReport) { r.Executors[0].CredentialScopeID = "account@example.com" }},
		{"unknown readiness", func(r *MediaExecutorReport) { r.Executors[0].Readiness = "maybe" }},
		{"duplicate executor", func(r *MediaExecutorReport) { r.Executors = append(r.Executors, r.Executors[0]) }},
		{"stale observation", func(r *MediaExecutorReport) { r.Executors[0].ObservedAt = time.Now().Add(-time.Hour).Unix() }},
		{"raw diagnostic", func(r *MediaExecutorReport) { r.Executors[0].ReasonCode = "failed: token=secret" }},
		{"whisk role loss", func(r *MediaExecutorReport) {
			e := &r.Executors[0]
			e.Provider = "whisk"
			e.ResolvedProvider = "flow"
			e.Capability = MediaImageWhiskV1
			e.InputRoles = []string{"subject"}
		}},
		{"unverified quota mapping", func(r *MediaExecutorReport) {
			r.Executors[0].PlanQuota = &RuntimePlanQuota{Provider: "codex", ObservedAt: time.Now().Unix()}
		}},
	}
	if err := ValidateMediaExecutorReport(validMediaReport(), time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := validMediaReport()
			tc.change(r)
			if ValidateMediaExecutorReport(r, time.Now()) == nil {
				t.Fatal("invalid report accepted")
			}
		})
	}
}
func TestMediaWhiskResolvedBackendAndRoles(t *testing.T) {
	r := validMediaReport()
	e := &r.Executors[0]
	e.Provider = "whisk"
	e.ResolvedProvider = "flow"
	e.Capability = MediaImageWhiskV1
	e.InputRoles = []string{"subject", "scene", "style"}
	if err := ValidateMediaExecutorReport(r, time.Now()); err != nil {
		t.Fatal(err)
	}
	e.ResolvedProvider = "whisk"
	if ValidateMediaExecutorReport(r, time.Now()) == nil {
		t.Fatal("false backend accepted")
	}
}
func TestMediaHeadersCannotAdvertiseNativeCapabilities(t *testing.T) {
	got := WithoutMediaCapabilities([]string{DaemonCapabilityRPCV1, MediaImageCodexV1, MediaImageAGYV1, MediaVideoFlowV1, MediaImageWhiskV1, DaemonCapabilityMediaJobsV1})
	if len(got) != 2 || got[0] != DaemonCapabilityRPCV1 || got[1] != DaemonCapabilityMediaJobsV1 {
		t.Fatalf("unexpected capabilities %v", got)
	}
}
func TestMediaControlRejectsManifestAndOversize(t *testing.T) {
	if _, err := MarshalMediaControl(MediaJobRequest{Prompt: "prompt"}); err == nil {
		t.Fatal("HTTP manifest entered control plane")
	}
	if _, err := MarshalMediaControl(MediaFailRequest{FailureCode: strings.Repeat("x", MediaControlMaxBytes)}); err == nil {
		t.Fatal("oversized frame accepted")
	}
	if _, err := MarshalMediaControl(MediaProgressRequest{Phase: "generating"}); err != nil {
		t.Fatal(err)
	}
}
