package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/effortmod"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/internal/daemon/jevsample"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// Claude per-step adaptive effort (OL-992 S3-1, contract §6): the
// labrastro-effort mod asks this endpoint for each main-thread step's level.
// The endpoint lives on the health server next to /repo/checkout and
// authenticates the same way: the task-scoped bearer token of a running task.

// thinkingDecisionRequest is the body the mod posts: the previous main-thread
// step's raw material (OL-1013). The daemon normalizes error features and
// counts repeats; the mod judges nothing.
type thinkingDecisionRequest struct {
	Step          int    `json:"step"` // 1-based
	AssistantText string `json:"assistant_text"`
	// Whole-or-omitted flags (#32): a field over the mod's byte limit ships
	// as "" with its flag set — never a partial body.
	AssistantOmitted bool `json:"assistant_omitted"`
	Tools            []struct {
		Name          string `json:"name"`
		IsError       bool   `json:"is_error"`
		IsFileContent bool   `json:"is_file_content"`
		InputSummary  string `json:"input_summary"`
		ResultText    string `json:"result_text"`
		InputOmitted  bool   `json:"input_summary_omitted"`
		ResultOmitted bool   `json:"result_omitted"`
	} `json:"tools"`
	ErrorText    string `json:"error_text"`
	ErrorOmitted bool   `json:"error_omitted"`
}

type thinkingDecisionResponse struct {
	// Enabled is false when this run's step-level effort is revoked. Such an
	// answer bypasses Jev and the health snapshot (contract §6).
	Enabled       *bool              `json:"enabled,omitempty"`
	Level         string             `json:"level,omitempty"`
	Confidence    float64            `json:"confidence,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	LatencyMS     int64              `json:"latency_ms,omitempty"`
	Source        string             `json:"source,omitempty"`
	Fallback      string             `json:"fallback,omitempty"`
}

// stepEffortRun is one task's step-decision state: the run-level context the
// decision needs, the enablement marker's path, and the error-feature
// tracking across steps.
type stepEffortRun struct {
	TaskID   string
	Provider string
	Model    string
	Clients  thinkingDecider
	Samples  *jevsample.Collector
	Trace    ThinkingDecisionTrace
	Goal     string
	// Candidates in catalog order; a decision must be one of them.
	Candidates []agent.ThinkingLevel
	// EnabledPath is the marker file; enabledNow reports whether it exists.
	EnabledPath string
	Errors      ErrorFeatureTracker

	stepMu    sync.Mutex // guards lastStep and Errors (replay guard + tracking)
	lastStep  int        // highest step this run has decided for
	effectsMu sync.Mutex
	// pending holds the latest effect record not yet applied to a message.
	pending *agent.EffortEffect
	// anyEffect reports whether at least one effect record arrived: once it
	// has, steps without a record carry no tag (contract §7 revocation).
	anyEffect bool
}

// observeEffect records one effect record from the mod. It runs on the
// stream reader; the next new main-thread message's tagging picks it up.
func (r *stepEffortRun) observeEffect(effect agent.EffortEffect) {
	r.effectsMu.Lock()
	defer r.effectsMu.Unlock()
	r.pending = &effect
	r.anyEffect = true
}

// sawEffect reports whether any effect record has arrived this run.
func (r *stepEffortRun) sawEffect() bool {
	r.effectsMu.Lock()
	defer r.effectsMu.Unlock()
	return r.anyEffect
}

// consumeEffect returns the pending effect record and, when `consume`, marks
// it applied — one locked step instead of a take/clear pair racing a new
// record from the stream reader.
func (r *stepEffortRun) consumeEffect(consume bool) *agent.EffortEffect {
	r.effectsMu.Lock()
	defer r.effectsMu.Unlock()
	effect := r.pending
	if consume {
		r.pending = nil
	}
	return effect
}

// effectMetadata shapes one effect record as the message metadata structure
// (contract §7): mode adapt, the level in effect, and either the decision's
// fields or the fallback.
func effectMetadata(effect agent.EffortEffect) map[string]any {
	thinking := map[string]any{"mode": "adapt", "level": effect.Level, "step": effect.Step}
	if effect.Fallback != "" {
		thinking["fallback"] = effect.Fallback
		if effect.LatencyMS > 0 {
			thinking["latency_ms"] = effect.LatencyMS
		}
		return thinking
	}
	thinking["confidence"] = effect.Confidence
	thinking["probabilities"] = effect.Probabilities
	thinking["latency_ms"] = effect.LatencyMS
	thinking["source"] = effect.Source
	return thinking
}

// tagStep applies the pending effect record to the first message of a new
// main-thread model request (and any thinking message of that request): the
// effect record arrives before the step's first assistant event (OL-1000).
// Once any effect has arrived, run-level tags stop landing: the caller drops
// the run-level metadata this run's tag() added (contract §7 — after
// revocation the level in effect is the last tagged one, and a run-level tag
// would misreport it and invent a gear change).
func (r *stepEffortRun) tagStep(msg agent.Message, firstOfRequest bool) agent.Message {
	if msg.ParentToolUseID != "" {
		// Subagent output: never step-tagged, and the run-level tag the
		// backend's tag() may have put there is that tag's business.
		return msg
	}
	if r.sawEffect() {
		if msg.Metadata != nil {
			delete(msg.Metadata, "thinking")
		}
	}
	// A thinking message of the same step keeps the effect pending for the
	// step's first message, which may not have arrived yet.
	isThinking := !firstOfRequest && msg.Type == agent.MessageThinking
	if !firstOfRequest && !isThinking {
		return msg
	}
	effect := r.consumeEffect(firstOfRequest)
	if effect == nil {
		return msg
	}
	msg.Metadata = maps.Clone(msg.Metadata)
	if msg.Metadata == nil {
		msg.Metadata = map[string]any{}
	}
	msg.Metadata["thinking"] = effectMetadata(*effect)
	return msg
}

// stepEffortRuns tracks the live step-effort runs by task id. The health
// endpoint reaches them by task id after bearer-token auth names the task.
type stepEffortRuns struct {
	mu   sync.Mutex
	runs map[string]*stepEffortRun
}

func (s *stepEffortRuns) add(run *stepEffortRun) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runs == nil {
		s.runs = map[string]*stepEffortRun{}
	}
	s.runs[run.TaskID] = run
}

func (s *stepEffortRuns) remove(taskID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.runs, taskID)
}

func (s *stepEffortRuns) get(taskID string) (*stepEffortRun, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[taskID]
	return run, ok
}

// enabledNow answers from the marker file: written after system/init reported
// per_turn_effort_active, removed on per_turn_effort_changed=false. Read per
// request so the race between removal and the next step answers "not
// enabled" instead of deciding for a revoked run.
func (r *stepEffortRun) enabledNow() bool {
	if r.EnabledPath == "" {
		return false
	}
	_, err := os.Stat(r.EnabledPath)
	return err == nil
}

// buildStepRequest turns the mod's raw material into the Jev request:
// step state per contract §4 plus the shared criteria.
func (r *stepEffortRun) buildStepRequest(req thinkingDecisionRequest) (jev.Request, StepThinkingInput) {
	r.stepMu.Lock()
	feature, repeats := r.Errors.Observe(req.ErrorText, req.ErrorOmitted)
	r.stepMu.Unlock()
	input := StepThinkingInput{
		Step:           req.Step,
		Goal:           r.Goal,
		AssistantText:  stepOmittedText(req.AssistantText, req.AssistantOmitted),
		ErrorFeatures:  feature,
		RepeatedErrors: repeats,
	}
	// The state describes one tool: the last failed one when the step had a
	// failure (its is_error/exit_code must agree with error_features), else
	// the last tool. Name and is_error always arrive: the mod never omits
	// them (OL-1013 wants the full tool list).
	for i := len(req.Tools) - 1; i >= 0; i-- {
		tool := req.Tools[i]
		if !tool.IsError {
			continue
		}
		input.ToolName = tool.Name
		input.ToolInputSummary = stepOmittedText(tool.InputSummary, tool.InputOmitted)
		input.ToolResult = stepOmittedText(tool.ResultText, tool.ResultOmitted)
		input.ToolIsError = true
		input.FileContent = tool.IsFileContent
		if code := ParseExitCode(tool.ResultText); code >= 0 {
			input.ExitCode = code
		}
		break
	}
	if !input.ToolIsError && len(req.Tools) > 0 {
		tool := req.Tools[len(req.Tools)-1]
		input.ToolName = tool.Name
		input.ToolInputSummary = stepOmittedText(tool.InputSummary, tool.InputOmitted)
		input.ToolResult = stepOmittedText(tool.ResultText, tool.ResultOmitted)
		input.ToolIsError = tool.IsError
		input.FileContent = tool.IsFileContent
	}
	return ThinkingRequest(BuildStepThinkingState(input), r.Candidates), input
}

// stepOmittedText marks a field the mod omitted whole; the state then says
// so instead of shipping an empty body as if nothing was there (#32).
func stepOmittedText(text string, omitted bool) string {
	if omitted {
		return "[omitted: over limit]"
	}
	return text
}

// decide answers one step: a level from Jev, a fallback reason, or "not
// enabled". Falls back (never errors the run) on any failure.
func (r *stepEffortRun) decide(ctx context.Context, req thinkingDecisionRequest) thinkingDecisionResponse {
	if !r.enabledNow() {
		var disabled bool
		return thinkingDecisionResponse{Enabled: &disabled}
	}
	r.stepMu.Lock()
	replayed := req.Step < 1 || req.Step <= r.lastStep
	if !replayed {
		r.lastStep = req.Step
	}
	r.stepMu.Unlock()
	if replayed {
		// Reject replays and regressions: each run asks at most once per
		// step, so a repeated or lower step is a buggy or chatty caller, and
		// answering it would both hit the external engine and advance the
		// run's error-feature tracking beyond the real steps.
		return thinkingDecisionResponse{Fallback: string(jev.ReasonInvalid)}
	}
	jevReq, _ := r.buildStepRequest(req)
	trace := r.Trace
	trace.Step = req.Step
	record := decideThinking(ctx, r.Clients, trace, jevReq, r.Samples)
	resp := thinkingDecisionResponse{LatencyMS: record.Decision.LatencyMS}
	if record.Fallback != "" {
		resp.Fallback = record.Fallback
		return resp
	}
	if !containsLevel(r.Candidates, record.Decision.Level) {
		// decideThinking already guarantees this; belt for a future change.
		resp.Fallback = string(jev.ReasonInvalid)
		return resp
	}
	resp.Level = record.Decision.Level
	resp.Confidence = record.Decision.Confidence
	resp.Probabilities = record.Decision.Probabilities
	resp.Source = record.Decision.Source
	return resp
}

func containsLevel(candidates []agent.ThinkingLevel, level string) bool {
	for _, candidate := range candidates {
		if candidate.Value == level {
			return true
		}
	}
	return false
}

// thinkingDecisionHandler serves POST /tasks/{task_id}/thinking-decision.
func (d *Daemon) thinkingDecisionHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		task, authResult := d.activeRepoCheckoutTask(r)
		if authResult != repoCheckoutAuthOK {
			reason := "no_credential"
			if authResult == repoCheckoutAuthUnknownCredential {
				reason = "unknown_credential"
			}
			d.logger.Warn("thinking decision rejected", "reason", reason)
			http.Error(w, "thinking decision requires an active task credential", http.StatusUnauthorized)
			return
		}
		if id := taskIDFromRequest(r); id != task.TaskID {
			// The token names one task; a different id in the path is either
			// a bug in the mod or an attempt to reach another task's run.
			http.Error(w, "task id does not match the credential", http.StatusForbidden)
			return
		}
		run, ok := d.stepEffort.get(task.TaskID)
		if !ok {
			// The run never registered (step effort off) or already ended.
			var disabled bool
			writeThinkingDecision(w, thinkingDecisionResponse{Enabled: &disabled})
			return
		}
		var req thinkingDecisionRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		writeThinkingDecision(w, run.decide(ctx, req))
	}
}

func writeThinkingDecision(w http.ResponseWriter, resp thinkingDecisionResponse) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// prepareStepEffort is the daemon-side gate for the per-step effort mod
// (contract §6): provider, _adapt request, CLI version, and ≥2 candidates
// all have to hold. startupEffort is the level the run started with — the
// run-level decision's level, or "" when that decision fell back (anything
// but no_candidates): the run still installs, the mod just starts with no
// level. Returns the mod's environment; nil means the mod should not load.
func (d *Daemon) prepareStepEffort(task Task, provider, model, cliVersion, requestedLevel, startupEffort string,
	runtimeCmd agent.Command, env *execenv.Environment, agentEnv map[string]string, log *slog.Logger) map[string]string {
	if provider != "claude" || requestedLevel != agent.ThinkingLevelAdapt || env == nil || env.MulticaConfigRoot == "" {
		return nil
	}
	if !agent.SupportsClaudePerTurnEffort(cliVersion) {
		log.Info("thinking_level: Claude Code is too old for per-step effort; run-level only",
			"claude_version", cliVersion, "minimum", agent.ClaudePerTurnEffortMinVersion)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	catalog, err := listModels(ctx, provider, runtimeCmd)
	if err != nil {
		log.Info("thinking_level: catalog unavailable; step effort off", "error", err)
		return nil
	}
	candidates := agent.ModelAdaptThinkingCandidates(catalog, provider, model)
	if len(candidates) < 2 {
		return nil
	}
	paths := effortmod.PathsFor(env.MulticaConfigRoot)
	vars, err := effortmod.Install(env.MulticaConfigRoot, effortmod.EffortContext{
		Version:       1,
		TaskID:        task.ID,
		Endpoint:      fmt.Sprintf("/tasks/%s/thinking-decision", task.ID),
		StartupEffort: startupEffort,
	})
	if err != nil {
		log.Warn("thinking_level: effort mod not installed; run-level only", "error", err)
		return nil
	}
	d.stepEffort.add(&stepEffortRun{
		TaskID:      task.ID,
		Provider:    provider,
		Model:       model,
		Clients:     d.jevClient,
		Samples:     d.jevSamples,
		Trace:       ThinkingDecisionTrace{TaskID: task.ID, Scope: "step", Provider: provider, Model: model},
		Goal:        StepThinkingGoal(task),
		Candidates:  candidates,
		EnabledPath: paths.EnabledFile,
	})
	existing := agentEnv[yskPluginDirsEnv]
	if existing == "" {
		existing = os.Getenv(yskPluginDirsEnv)
	}
	vars[yskPluginDirsEnv] = effortmod.MergePluginDir(existing, paths.Plugin)
	return vars
}

const yskPluginDirsEnv = "CLAUDE_CODE_PLUGIN_DIRS"

// setStepEffortEnabled writes or removes the enablement marker for a task's
// step-effort run (contract §6: after system/init, and on
// per_turn_effort_changed=false).
func (d *Daemon) setStepEffortEnabled(taskID string, enabled bool) {
	run, ok := d.stepEffort.get(taskID)
	if !ok {
		return
	}
	if enabled {
		if err := os.WriteFile(run.EnabledPath, []byte{}, 0o600); err != nil {
			d.logger.Warn("thinking_level: cannot write the effort enablement marker", "error", err)
		}
		return
	}
	if err := os.Remove(run.EnabledPath); err != nil && !os.IsNotExist(err) {
		d.logger.Warn("thinking_level: cannot remove the effort enablement marker", "error", err)
	}
}

// perTurnEffortCallback is the ExecOptions.OnPerTurnEffort wiring: system
// frames' per-turn effort state writes or removes the run's enablement
// marker (contract §6). Extracted so tests can drive it end to end.
func (d *Daemon) perTurnEffortCallback(taskID string) func(bool) {
	return func(active bool) { d.setStepEffortEnabled(taskID, active) }
}

// tagThinkingMessage is the transcript's single tagging boundary: the
// run-level tag always runs (it owns request-id dedup, which decides step
// boundaries, and the fallback tag); step-level effort then replaces it on
// this step's messages, or drops it once step tags have landed (contract
// §7). Extracted from executeAndDrain so tests drive the same wiring the
// drain loop uses.
func (d *Daemon) tagThinkingMessage(ctx context.Context, taskID string, msg agent.Message) agent.Message {
	thinking := thinkingRunFromContext(ctx)
	if thinking == nil {
		return msg
	}
	msg = thinking.tag(msg)
	if stepRun, ok := d.stepEffort.get(taskID); ok {
		msg = stepRun.tagStep(msg, thinking.lastTagFirstOfRequest())
	}
	return msg
}
