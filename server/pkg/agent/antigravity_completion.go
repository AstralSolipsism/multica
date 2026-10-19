package agent

import "strings"

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
	latest := -1
	for index, step := range c.steps {
		if index > start && step.kind == "agent_response" && index > latest {
			latest = index
		}
	}
	if latest < 0 || c.steps[latest].state != "DONE" {
		return false
	}
	// Match the final response step to the canonical reply. A nonempty result
	// alone might be stale or only partial. Multiple response steps whose text
	// cannot be attributed to this final reply deliberately remain failures.
	if c.steps[latest].text.String() != response {
		return false
	}
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
