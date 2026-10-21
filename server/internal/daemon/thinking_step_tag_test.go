package daemon

import (
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// TestStepEffortTagStepUnit pins tagStep's own rules: the pending effect
// lands on the first message of a request and on thinking messages; later
// events of the same request carry none; once any effect has been seen the
// run-level tag a caller applied is dropped.
func TestStepEffortTagStepUnit(t *testing.T) {
	t.Parallel()
	step := &stepEffortRun{}
	step.observeEffect(agent.EffortEffect{Step: 2, Level: "high", Source: "zen"})

	first := step.tagStep(agent.Message{Type: agent.MessageText, ModelRequestID: "m1", Metadata: map[string]any{"thinking": map[string]any{"level": "low"}}}, true)
	meta := first.Metadata["thinking"].(map[string]any)
	if meta["step"] != 2 || meta["level"] != "high" {
		t.Fatalf("first message: %+v", meta)
	}
	later := step.tagStep(agent.Message{Type: agent.MessageToolUse, ModelRequestID: "m1", Metadata: map[string]any{}}, false)
	if _, has := later.Metadata["thinking"]; has {
		t.Fatalf("later event tagged: %+v", later.Metadata)
	}
	// After the effect was consumed (revocation): no pending record, and a
	// run-level tag the caller applied is dropped, not kept.
	after := step.tagStep(agent.Message{Type: agent.MessageText, ModelRequestID: "m2", Metadata: map[string]any{"thinking": map[string]any{"level": "low"}}}, true)
	if _, has := after.Metadata["thinking"]; has {
		t.Fatalf("post-revocation run-level tag survived: %+v", after.Metadata)
	}
	// Subagent messages never carry a step tag and keep their metadata.
	sub := step.tagStep(agent.Message{Type: agent.MessageText, ParentToolUseID: "task", Metadata: map[string]any{"thinking": map[string]any{"level": "low"}}}, true)
	if _, has := sub.Metadata["thinking"]; !has {
		t.Fatalf("subagent run-level tag was dropped: %+v", sub.Metadata)
	}
}

// TestStepEffortFallbackTagCarriesLevelAndReason locks the supplementary
// acceptance: a fallback record's level is the level actually in effect and
// the reason is stated; an empty level stays empty.
func TestStepEffortFallbackTagCarriesLevelAndReason(t *testing.T) {
	t.Parallel()
	effect := agent.EffortEffect{Step: 4, Level: "high", Fallback: "timeout"}
	meta := effectMetadata(effect)
	if meta["mode"] != "adapt" || meta["level"] != "high" || meta["fallback"] != "timeout" || meta["step"] != 4 {
		t.Fatalf("fallback metadata: %+v", meta)
	}
	if _, ok := meta["confidence"]; ok {
		t.Fatalf("fallback metadata carries confidence: %+v", meta)
	}
	// Run-level fallback, no decision ever: empty level.
	empty := effectMetadata(agent.EffortEffect{Step: 2, Level: "", Fallback: "error"})
	if empty["level"] != "" {
		t.Fatalf("empty-level fallback: %+v", empty)
	}
}
