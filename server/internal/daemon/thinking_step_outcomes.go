package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"

	"github.com/multica-ai/multica/server/internal/daemon/jevsample"
)

// Exact Claude tool names only. Bash, Task, MCP tools and unknown names may
// execute or mutate state, even when their particular input looks read-only.
const stepReadOnlyTools = "Read,Grep,Glob,LS,WebFetch,WebSearch,NotebookRead"

type stepOutcomeState struct {
	sample jevsample.StepOutcome
	// Keep the latest error across successful edits. ErrorFeatureTracker's
	// consecutive count intentionally resets there and cannot answer this.
	lastErrorSig *string
	written      bool
}

// All history helpers require stepMu. Only derived signals are retained.
func (r *stepEffortRun) stepOutcome(step int) *stepOutcomeState {
	if r.steps == nil {
		r.steps = make(map[int]*stepOutcomeState)
	}
	if r.steps[step] == nil {
		r.steps[step] = &stepOutcomeState{}
	}
	return r.steps[step]
}

func (r *stepEffortRun) observeStepOutcome(req thinkingDecisionRequest) {
	if r.Samples == nil || req.Step <= 1 {
		return
	}
	step := req.Step - 1
	s := r.stepOutcome(step)
	tools := make([]string, 0, len(req.Tools))
	kind, ok := "final_text", true
	if len(req.Tools) > 0 {
		kind = "read_only"
	}
	readOnlyTools := strings.Split(stepReadOnlyTools, ",")
	for _, tool := range req.Tools {
		tools = append(tools, tool.Name)
		if !slices.Contains(readOnlyTools, tool.Name) {
			kind = "edit_or_exec"
		}
		ok = ok && !tool.IsError
	}
	s.sample.Tools, s.sample.ActionKind, s.sample.OutcomeOK = tools, &kind, &ok
	sig := ""
	if !ok {
		if feature := NormalizedErrorFeature(req.ErrorText); feature != "" {
			sum := sha256.Sum256([]byte(feature))
			sig = hex.EncodeToString(sum[:8])
		}
	}
	s.sample.ErrorSig = &sig
	if req.ErrorOmitted {
		s.sample.ErrorSig = nil
	}
	r.inheritStepError(step)
	if prev := r.steps[step-1]; prev != nil && prev.sample.OutcomeOK != nil {
		r.writeStepOutcome(step - 1)
	}
}

func (r *stepEffortRun) inheritStepError(step int) {
	s := r.steps[step]
	if s.sample.OutcomeOK == nil {
		return
	}
	if !*s.sample.OutcomeOK || s.sample.ErrorSig == nil {
		s.lastErrorSig = s.sample.ErrorSig
	} else if prev := r.steps[step-1]; prev != nil {
		s.lastErrorSig = prev.lastErrorSig
	} else if step == 1 {
		empty := ""
		s.lastErrorSig = &empty
	}
}

func (r *stepEffortRun) writeStepOutcome(step int) {
	s := r.steps[step]
	if s == nil || s.written || s.sample.DecisionID == "" {
		return
	}
	if prev := r.steps[step-1]; prev != nil {
		s.sample.PrevActionKind = prev.sample.ActionKind
		s.sample.PrevOutcomeOK = prev.sample.OutcomeOK
	}
	if next := r.steps[step+1]; next != nil {
		s.sample.NextOutcomeOK = next.sample.OutcomeOK
		if next.sample.OutcomeOK != nil && next.sample.ErrorSig != nil && s.lastErrorSig != nil {
			repeated := !*next.sample.OutcomeOK && *s.lastErrorSig != "" && *next.sample.ErrorSig == *s.lastErrorSig
			s.sample.RepeatedErrorNext = &repeated
		}
	}
	r.Samples.StepOutcome(s.sample)
	s.written = true
}

func (r *stepEffortRun) finishStepOutcomes() {
	// A decision already in flight must publish its SampleID before flushing;
	// a request holding a stale run pointer must not decide after the flush.
	r.decisionMu.Lock()
	defer r.decisionMu.Unlock()
	r.finished = true
	r.stepMu.Lock()
	defer r.stepMu.Unlock()
	if s := r.steps[r.lastDecisionStep]; s != nil && s.sample.OutcomeOK == nil &&
		r.lastEffectStep == r.lastDecisionStep && !r.toolAfterEffect {
		kind, ok, sig := "final_text", true, ""
		s.sample.Tools = []string{}
		s.sample.ActionKind, s.sample.OutcomeOK, s.sample.ErrorSig = &kind, &ok, &sig
		r.inheritStepError(r.lastDecisionStep)
	}
	// Emit chronologically, without iterating through potentially missing
	// step numbers supplied by the endpoint caller.
	steps := make([]int, 0, len(r.steps))
	for step := range r.steps {
		steps = append(steps, step)
	}
	slices.Sort(steps)
	for _, step := range steps {
		r.writeStepOutcome(step)
	}
}
