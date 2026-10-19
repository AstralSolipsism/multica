package agent

import (
	"os/exec"
	"strings"
)

const antigravityStreamInterruptedError = "The stream was interrupted. Please continue the task you were working on."

type antigravityCompletionStep struct {
	kind, state, lastDelta string
	text                   *strings.Builder
}

// Completion evidence is local to one print invocation. A user_input index
// separates this turn from historical snapshots; arrival order alone does not.
// See docs/engineering/antigravity-completion.md for the wire assumptions.
type antigravityCompletion struct {
	turnStart    *int
	steps        map[int]antigravityCompletionStep
	conversation string
	invalid      bool
	pending      []*antigravityStreamStepUpdate
}

// admit holds resumed snapshots until a user-input boundary establishes their
// ownership. Streams without a boundary keep their diagnostic output, but may
// not use the recovery exception. A late boundary cannot prove completion.
func (c *antigravityCompletion) admit(step *antigravityStreamStepUpdate, resumed bool) bool {
	if !resumed || c.turnStart != nil {
		return true
	}
	if step.StepType != "user_input" {
		c.pending = append(c.pending, step)
		return false
	}
	for _, pending := range c.takePending() {
		if pending.StepIndex == nil || *pending.StepIndex < 0 || step.StepIndex == nil || *pending.StepIndex >= *step.StepIndex {
			c.invalid = true
		}
	}
	return true
}

func (c *antigravityCompletion) takePending() []*antigravityStreamStepUpdate {
	pending := c.pending
	c.pending = nil
	return pending
}

func (c *antigravityCompletion) observeConversation(id string) {
	if id == "" {
		return
	}
	if c.conversation != "" && c.conversation != id {
		c.invalid = true
	}
	c.conversation = id
}

// observe returns whether a text delta is new and belongs to this turn. Usage
// snapshots are still replaceable after DONE, but terminal text is emitted once.
func (c *antigravityCompletion) observe(step *antigravityStreamStepUpdate) bool {
	c.observeConversation(step.ConversationID)
	if step.StepIndex == nil || *step.StepIndex < 0 {
		c.invalid = true
		return true // Preserve diagnostic output, but never infer completion.
	}
	index := *step.StepIndex
	if step.StepType == "user_input" {
		if c.turnStart != nil && *c.turnStart != index {
			// -p submits exactly one prompt. Multiple distinct boundaries cannot
			// be assigned to it reliably, even if the last reply looks complete.
			c.invalid = true
		}
		if c.turnStart == nil || index > *c.turnStart {
			start := index
			c.turnStart = &start
		}
	}
	if c.turnStart != nil && index < *c.turnStart {
		return false
	}
	if c.steps == nil {
		c.steps = make(map[int]antigravityCompletionStep)
	}
	previous, exists := c.steps[index]
	state := strings.ToUpper(step.State)
	if (state != "ACTIVE" && state != "DONE") || (exists && previous.kind != step.StepType) {
		c.invalid = true
	}
	if exists && previous.state == "DONE" {
		if state != "DONE" || (step.TextDelta != "" && step.TextDelta != previous.lastDelta) {
			// There is no sequence number to resolve a regressing state or a
			// conflicting terminal delta. Fail closed instead of guessing.
			c.invalid = true
		}
		return false
	}
	previous.kind, previous.state, previous.lastDelta = step.StepType, state, step.TextDelta
	if step.StepType == "agent_response" {
		if previous.text == nil {
			previous.text = &strings.Builder{}
		}
		previous.text.WriteString(step.TextDelta)
	}
	c.steps[index] = previous
	return true
}

func (c *antigravityCompletion) completedDespiteError(status, providerError, response string, resumed bool) bool {
	// Cancellation, timeout, INTERRUPTED, WAITING and unknown terminal states
	// must never be converted into success, even with a familiar error string.
	if status != "ERROR" || c.invalid || strings.TrimSpace(response) == "" {
		return false
	}
	legacy := strings.EqualFold(strings.TrimSpace(providerError), antigravityNetworkIssueError)
	if !legacy && providerError != antigravityStreamInterruptedError {
		return false
	}
	start := -1
	if c.turnStart != nil {
		start = *c.turnStart
		if c.steps[start].state != "DONE" {
			return false
		}
	} else if !legacy || resumed {
		// Older fresh-run network-error fixtures predate user_input events.
		// A resumed invocation or the new interruption workaround needs an
		// explicit boundary; an arbitrary historical DONE is not evidence.
		return false
	}
	latest := c.latestStepIndex("agent_response", start)
	if latest < 0 || c.steps[latest].state != "DONE" {
		return false
	}
	if !legacy && !c.interruptionRecovered(start, latest, resumed) {
		return false
	}
	// Match the final response step to the canonical reply. A nonempty result
	// alone might be stale or only partial. agy may append one terminal LF to
	// the result; preserve all other whitespace and the original output bytes.
	if strings.TrimSuffix(c.steps[latest].text.String(), "\n") != strings.TrimSuffix(response, "\n") {
		return false
	}
	return c.stepsSettled(start, latest, legacy)
}

func (c *antigravityCompletion) latestStepIndex(kind string, after int) int {
	latest := -1
	for index, step := range c.steps {
		if index > after && step.kind == kind && index > latest {
			latest = index
		}
	}
	return latest
}

func (c *antigravityCompletion) interruptionRecovered(start, latest int, resumed bool) bool {
	lastError := c.latestStepIndex("error_message", start)
	if lastError < 0 {
		// A fresh conversation has no history to carry an old error. DONE
		// narration before a terminal interruption is not a recovered turn.
		return resumed
	}
	return lastError < latest && !c.hasResponseTextBetween(start, lastError)
}

func (c *antigravityCompletion) hasResponseTextBetween(start, end int) bool {
	for index, step := range c.steps {
		if index > start && index < end && step.kind == "agent_response" && step.text.Len() > 0 {
			// The last response may only continue an interrupted earlier one.
			// Without a protocol-level distinction from narration, retain the
			// failure rather than publish that suffix as a complete answer.
			return true
		}
	}
	return false
}

func (c *antigravityCompletion) stepsSettled(start, latest int, legacy bool) bool {
	for index, step := range c.steps {
		if index <= start {
			continue
		}
		if index > latest && (step.kind != "checkpoint" || step.state != "DONE") {
			// In particular an error_message after the reply is a current error,
			// not the recovered/historical error in result.error. A later tool
			// also needs a subsequent response before it can be called finished.
			return false
		}
		if !legacy && step.state != "DONE" {
			return false
		}
	}
	return true
}

// These gates restrict recovery, not the precedence of failure diagnostics.
func antigravityRecoverableResult(waitErr error, resultSeen, printTimedOut bool, providerError string) bool {
	if !resultSeen || printTimedOut || providerError != "" {
		return false
	}
	if waitErr == nil {
		return true
	}
	// agy has used both 1 and 3 for provider errors. Signals and other process
	// failures must not be hidden by an earlier result event.
	exitErr, ok := waitErr.(*exec.ExitError)
	return ok && (exitErr.ExitCode() == 1 || exitErr.ExitCode() == 3)
}
