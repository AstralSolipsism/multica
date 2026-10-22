package agent

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// agy's terminal result describes the conversation, not this invocation: after
// a resumed turn has answered, it can still repeat an error an earlier turn
// recorded. An ERROR result is therefore judged by the invocation's own steps.
// docs/engineering/antigravity-completion.md records the wire assumptions.

// antigravityTurn collects the step evidence of one print invocation. The
// completed user_input step that opens the turn separates its steps from
// replayed history; arrival order alone does not.
type antigravityTurn struct {
	resumed      bool
	start        *int
	steps        map[int]antigravityTurnStep
	conversation string
	invalid      bool
	pending      []*antigravityStreamStepUpdate
}

type antigravityTurnStep struct {
	kind, state, lastDelta string
	text                   *strings.Builder
}

func newAntigravityTurn(resumeSessionID string) *antigravityTurn {
	return &antigravityTurn{
		resumed:      resumeSessionID != "",
		conversation: resumeSessionID,
		steps:        make(map[int]antigravityTurnStep),
	}
}

// admit holds a resumed conversation's snapshots until the boundary shows which
// turn they belong to. The boundary discards those below it as history. Any
// other held snapshot arrived out of order: it invalidates the evidence but
// stays pending, so its output is released after the boundary. Without any
// boundary the held snapshots are released at the result, but they cannot
// prove completion.
func (t *antigravityTurn) admit(step *antigravityStreamStepUpdate) bool {
	if !t.resumed || t.start != nil {
		return true
	}
	if step.StepType != "user_input" {
		t.pending = append(t.pending, step)
		return false
	}
	current := t.pending[:0]
	for _, held := range t.pending {
		if held.StepIndex != nil && *held.StepIndex >= 0 && step.StepIndex != nil && *held.StepIndex < *step.StepIndex {
			continue
		}
		t.invalid = true
		current = append(current, held)
	}
	t.pending = current
	return true
}

func (t *antigravityTurn) takePending() []*antigravityStreamStepUpdate {
	pending := t.pending
	t.pending = nil
	return pending
}

func (t *antigravityTurn) observeConversation(id string) {
	if id == "" {
		return
	}
	if t.conversation != "" && t.conversation != id {
		t.invalid = true
	}
	t.conversation = id
}

// observe records a snapshot and reports whether its text delta is new output
// of this turn. A repeated DONE snapshot may still replace usage, but its text
// is emitted once.
func (t *antigravityTurn) observe(step *antigravityStreamStepUpdate) bool {
	t.observeConversation(step.ConversationID)
	if step.StepIndex == nil || *step.StepIndex < 0 {
		t.invalid = true
		return true // Keep the diagnostic output, but never infer completion.
	}
	index := *step.StepIndex
	if step.StepType == "user_input" {
		if t.start != nil && *t.start != index {
			// -p submits one prompt; several boundaries cannot be attributed to it.
			t.invalid = true
		}
		if t.start == nil || index > *t.start {
			start := index
			t.start = &start
		}
	}
	if t.historical(step) {
		return false
	}
	previous, exists := t.steps[index]
	state := strings.ToUpper(step.State)
	if (state != "ACTIVE" && state != "DONE") || (exists && previous.kind != step.StepType) {
		t.invalid = true
	}
	if exists && previous.state == "DONE" {
		if state != "DONE" || (step.TextDelta != "" && step.TextDelta != previous.lastDelta) {
			// Without a sequence number, a regressing state or a different
			// terminal delta cannot be resolved. Fail closed instead of guessing.
			t.invalid = true
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
	t.steps[index] = previous
	return true
}

// historical reports whether a snapshot precedes this turn's boundary.
func (t *antigravityTurn) historical(step *antigravityStreamStepUpdate) bool {
	return t.start != nil && step.StepIndex != nil && *step.StepIndex < *t.start
}

// antigravityAnswer is what one invocation's steps prove about result.response.
type antigravityAnswer int

const (
	antigravityNoAnswer antigravityAnswer = iota
	// A completed user_input boundary, followed by a settled answer that
	// matches the response.
	antigravityTurnAnswer
	// The same settled answer in a fresh stream that has no boundary at all,
	// as emitted by agy releases without user_input steps.
	antigravityLegacyAnswer
)

func (t *antigravityTurn) answer(response string) antigravityAnswer {
	if t.invalid || strings.TrimSpace(response) == "" {
		return antigravityNoAnswer
	}
	start, evidence := -1, antigravityLegacyAnswer
	if t.start != nil {
		start, evidence = *t.start, antigravityTurnAnswer
		if t.steps[start].state != "DONE" {
			return antigravityNoAnswer
		}
	} else if t.resumed {
		// A resumed stream without a boundary cannot tell this turn's answer
		// from a replayed one.
		return antigravityNoAnswer
	}
	if !t.settled(start, response) {
		return antigravityNoAnswer
	}
	return evidence
}

// settled requires the latest response after start to be DONE and to match the
// canonical response, followed by nothing but DONE checkpoints: a later error or
// tool belongs to this turn and was never answered. An earlier error may have
// been recovered by the answer, unless response text precedes it. The answer
// could then continue an interrupted reply, and the protocol does not tell
// narration from a partial answer. Earlier unfinished steps are allowed: agy
// leaves a background command ACTIVE when a separate step cancels it.
func (t *antigravityTurn) settled(start int, response string) bool {
	latest := t.latest("agent_response", start)
	if latest < 0 || t.steps[latest].state != "DONE" {
		return false
	}
	// agy may append one terminal LF to the result; every other byte must match.
	if strings.TrimSuffix(t.steps[latest].text.String(), "\n") != strings.TrimSuffix(response, "\n") {
		return false
	}
	lastError := t.latest("error_message", start)
	for index, step := range t.steps {
		switch {
		case index <= start: // the boundary and anything before it
		case index > latest && (step.kind != "checkpoint" || step.state != "DONE"):
			return false
		case index < lastError && step.kind == "agent_response" && step.text.Len() > 0:
			return false
		}
	}
	return true
}

func (t *antigravityTurn) latest(kind string, after int) int {
	latest := -1
	for index, step := range t.steps {
		if index > after && step.kind == kind && index > latest {
			latest = index
		}
	}
	return latest
}

// antigravityNetworkIssueError is the provider sentence some agy releases
// report when a trailing round trip fails. It carries no Go error text, so it
// has to stay a literal match alongside the transport patterns below.
const antigravityNetworkIssueError = "There was a network issue connecting to the server, please try again."

// antigravityTransportErrorRe gates only the legacy row of
// decideAntigravityOutcome: a fresh stream without a user_input step, from agy
// releases that predate it. Such a stream cannot show where its turn began, so
// these spellings, adopted from upstream #8983, remain the only errors it can
// recover from. Streams with a boundary are judged by their steps whatever the
// error says, so no spelling may be added here.
//
// The pattern matches the causes Go's http client reports when a round trip
// never produced a response: socket, DNS and TLS failures. These are the
// strings that appear inside the `*url.Error` agy wraps as
// `API error (attempt N): request failed: Post "...": <cause>`.
//
// Two things are deliberately excluded.
//
//   - agy's own `request failed:` prefix. It is tempting to match it directly
//     since it marks an http.Client failure, but only one spelling has been
//     observed in the field, and nothing rules out agy reusing the same prefix
//     for an HTTP status error. Matching the cause keeps a provider rejection
//     from being read as transport noise.
//   - Provider-side rejections: quota, capacity, overload, policy and auth all
//     arrive as an HTTP response, so they are decisions about the request
//     rather than a failure to deliver it. Without a turn boundary they must
//     stay failures the user sees.
var antigravityTransportErrorRe = regexp.MustCompile(`(?i)(\bEOF\b|connection reset by peer|broken pipe|connection refused|connection timed out|i/o timeout|tls handshake timeout|tls: handshake failure|use of closed network connection|network is unreachable|no such host|server misbehaving|malformed HTTP response|http2: client connection lost|http2: server sent GOAWAY)`)

// antigravityTrailingTransportError reports whether agy's provider error
// describes a transport-level failure rather than a decision the provider made
// about the request.
func antigravityTrailingTransportError(providerError string) bool {
	trimmed := strings.TrimSpace(providerError)
	if trimmed == "" {
		return false
	}
	if strings.EqualFold(trimmed, antigravityNetworkIssueError) {
		return true
	}
	return antigravityTransportErrorRe.MatchString(trimmed)
}

// antigravityCompletedDespiteTrailingNetworkError is the legacy row's
// predicate. All three conditions are required: the trailing failure has to be
// transport-level, agy has to have handed back a non-empty canonical response,
// and agentResponseDone has to report a settled answer — for the decision
// table, antigravityLegacyAnswer.
func antigravityCompletedDespiteTrailingNetworkError(providerError, response string, agentResponseDone bool) bool {
	return antigravityTrailingTransportError(providerError) &&
		strings.TrimSpace(response) != "" &&
		agentResponseDone
}

// antigravityRunFacts are the signals available once agy has exited.
type antigravityRunFacts struct {
	ctxErr        error
	timeout       time.Duration
	status        string // result.status; empty when no result arrived
	resultError   string
	response      string
	answer        antigravityAnswer
	waitErr       error
	printTimedOut bool
	providerError string // terminal provider error from the per-run log
}

type antigravityOutcome struct {
	status, err string
	// recovered names the evidence that replaced agy's ERROR result.
	recovered string
}

// decideAntigravityOutcome is the adapter's terminal decision table: rows apply
// in order and the first match wins. Only an ERROR result is replaceable, and
// only when nothing about the process contradicts the answer.
func decideAntigravityOutcome(f antigravityRunFacts) antigravityOutcome {
	replaceable := strings.EqualFold(strings.TrimSpace(f.status), "ERROR") &&
		antigravityProviderExit(f.waitErr) && !f.printTimedOut && f.providerError == ""
	status := antigravityResultStatus(f.status)
	switch {
	case f.ctxErr == context.DeadlineExceeded: // 1
		return antigravityOutcome{status: "timeout", err: fmt.Sprintf("agy timed out after %s", f.timeout)}
	case f.ctxErr == context.Canceled: // 2
		return antigravityOutcome{status: "aborted", err: "execution cancelled"}
	case replaceable && f.answer == antigravityTurnAnswer: // 3
		return antigravityOutcome{status: "completed", recovered: "current turn"}
	case replaceable && antigravityCompletedDespiteTrailingNetworkError(f.resultError, f.response, f.answer == antigravityLegacyAnswer): // 4
		// Legacy compatibility, the only wording-based row; see
		// antigravityTransportErrorRe.
		return antigravityOutcome{status: "completed", recovered: "legacy transport error"}
	case status != "completed": // 5
		// The structured error carries the actionable cause, even when agy also
		// exits non-zero.
		err := f.resultError
		if err == "" {
			err = fmt.Sprintf("agy returned status %s", f.status)
		}
		return antigravityOutcome{status: status, err: err}
	case f.waitErr != nil: // 6
		return antigravityOutcome{status: "failed", err: fmt.Sprintf("agy exited with error: %v", f.waitErr)}
	case f.printTimedOut: // 7
		// agy exits 0 when its own --print-timeout elapses (MUL-3570).
		return antigravityOutcome{status: "timeout", err: fmt.Sprintf(
			"agy --print-timeout elapsed after %s waiting for the agent response; a long-running command likely outlived the print timeout",
			antigravityPrintTimeout(f.timeout),
		)}
	case f.providerError != "": // 8
		// agy can log a terminal provider failure and still exit 0 with empty
		// stdout.
		return antigravityOutcome{status: "failed", err: fmt.Sprintf("agy provider error: %s", f.providerError)}
	default: // 9
		return antigravityOutcome{status: "completed"}
	}
}

// antigravityProviderExit reports a normal exit or one of the codes agy has
// used for provider errors. Signals and other codes are process failures an
// earlier result event must not hide.
func antigravityProviderExit(waitErr error) bool {
	if waitErr == nil {
		return true
	}
	var exitErr *exec.ExitError
	return errors.As(waitErr, &exitErr) && (exitErr.ExitCode() == 1 || exitErr.ExitCode() == 3)
}
