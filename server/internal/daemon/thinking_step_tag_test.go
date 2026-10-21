package daemon

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// TestStepEffortTagMarksByDeduplicatedRequestID locks the §7 tagging rule:
// each step's tag lands on the step's first message (a new main-thread
// request id) and on thinking messages; later events of the same request
// carry none.
func TestStepEffortTagMarksByDeduplicatedRequestID(t *testing.T) {
	t.Parallel()
	run := &thinkingRun{Record: &ThinkingDecisionRecord{Mode: "adapt", Decision: jev.Decision{Level: "low"}}}
	step := &stepEffortRun{}
	step.observeEffect(agent.EffortEffect{Step: 2, Level: "high", Source: "zen", Confidence: 0.8, Probabilities: map[string]float64{"high": 0.8}})

	tag := func(msg agent.Message) agent.Message {
		msg = run.tag(msg)
		return step.tagStep(msg, run.lastTagFirstOfRequest())
	}

	thinking := tag(agent.Message{Type: agent.MessageThinking, Content: "hmm", ModelRequestID: "msg_1"})
	text := tag(agent.Message{Type: agent.MessageText, Content: "step two", ModelRequestID: "msg_1"})
	nextFirst := tag(agent.Message{Type: agent.MessageText, Content: "next step", ModelRequestID: "msg_2"})
	nextSecond := tag(agent.Message{Type: agent.MessageToolUse, ModelRequestID: "msg_2"})

	meta := func(msg agent.Message) map[string]any {
		t.Helper()
		thinking, ok := msg.Metadata["thinking"].(map[string]any)
		if !ok {
			t.Fatalf("message %+v carries no thinking tag", msg)
		}
		return thinking
	}
	// The step's first message (here the thinking event) carries the step tag.
	if got := meta(thinking); got["step"] != 2 || got["level"] != "high" {
		t.Fatalf("thinking of the step: %+v", got)
	}
	// A later event of the same request carries no step tag.
	if text.Metadata != nil && text.Metadata["thinking"] != nil {
		t.Fatalf("later event of the same request carries a tag: %+v", text.Metadata)
	}
	// The effect is consumed by the first message; the next request's first
	// message shows the run-level tag (no step field), its second none.
	nextMeta := meta(nextFirst)
	if _, has := nextMeta["step"]; has {
		t.Fatalf("stale step tag on the next request: %+v", nextMeta)
	}
	if nextSecond.Metadata != nil && nextSecond.Metadata["thinking"] != nil {
		t.Fatalf("a later event of the next request carries a tag: %+v", nextSecond.Metadata)
	}
}

// TestStepEffortTagKeepsEffectForLaterFirstMessage covers the order where the
// step's thinking event arrives before the step's first non-thinking
// message: the thinking message gets the tag without consuming the effect
// meant for the step's first message.
func TestStepEffortTagKeepsEffectForLaterFirstMessage(t *testing.T) {
	t.Parallel()
	run := &thinkingRun{Record: &ThinkingDecisionRecord{Mode: "adapt", Decision: jev.Decision{Level: "low"}}}
	step := &stepEffortRun{}
	step.observeEffect(agent.EffortEffect{Step: 3, Level: "max"})

	tag := func(msg agent.Message) agent.Message {
		msg = run.tag(msg)
		return step.tagStep(msg, run.lastTagFirstOfRequest())
	}

	// A subagent message first: the step tag never lands on it (the run-level
	// tag is pre-existing behavior).
	subagent := tag(agent.Message{Type: agent.MessageText, Content: "sub", ModelRequestID: "sub_1", ParentToolUseID: "task_1"})
	if subagent.Metadata != nil {
		if _, has := subagent.Metadata["thinking"].(map[string]any); !has {
			t.Fatalf("unexpected metadata: %+v", subagent.Metadata)
		}
		if meta := subagent.Metadata["thinking"].(map[string]any); meta["step"] != nil {
			t.Fatalf("subagent message carries a step tag: %+v", meta)
		}
	}
	if step.takeEffect() == nil {
		t.Fatalf("a subagent message consumed the step effect")
	}
	// A thinking message of the step, arriving before any other main-thread
	// event: it IS the step's first message, carries the tag and consumes
	// the effect.
	thinking := tag(agent.Message{Type: agent.MessageThinking, Content: "deep", ModelRequestID: "msg_5"})
	meta, ok := thinking.Metadata["thinking"].(map[string]any)
	if !ok || meta["step"] != 3 {
		t.Fatalf("thinking as the step's first message: %+v", thinking.Metadata)
	}
	if step.takeEffect() != nil {
		t.Fatalf("effect not consumed by the step's first message")
	}
	// A later event of the same request carries no step tag.
	later := tag(agent.Message{Type: agent.MessageText, Content: "first", ModelRequestID: "msg_5"})
	if later.Metadata != nil && later.Metadata["thinking"] != nil {
		if meta := later.Metadata["thinking"].(map[string]any); meta["step"] != nil {
			t.Fatalf("later event carries a step tag: %+v", meta)
		}
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
