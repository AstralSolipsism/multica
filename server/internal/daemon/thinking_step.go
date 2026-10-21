package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"maps"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/effortmod"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/internal/daemon/jev"
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
	Tools         []struct {
		Name         string `json:"name"`
		IsError      bool   `json:"is_error"`
		InputSummary string `json:"input_summary"`
		ResultText   string `json:"result_text"`
	} `json:"tools"`
	ErrorText string `json:"error_text"`
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
	Trace    ThinkingDecisionTrace
	Goal     string
	// Candidates in catalog order; a decision must be one of them.
	Candidates []agent.ThinkingLevel
	// EnabledPath is the marker file; enabledNow reports whether it exists.
	EnabledPath string
	Errors      ErrorFeatureTracker

	effectsMu sync.Mutex
	// pending holds the latest effect record not yet applied to a message.
	pending *agent.EffortEffect
}

// observeEffect records one effect record from the mod. It runs on the
// stream reader; the next new main-thread message's tagging picks it up.
func (r *stepEffortRun) observeEffect(effect agent.EffortEffect) {
	r.effectsMu.Lock()
	defer r.effectsMu.Unlock()
	r.pending = &effect
}

// takeEffect returns the pending effect record, if any, without clearing it:
// the tagger applies it to the next new main-thread message id and every
// thinking message of that step (contract §7), then clears it.
func (r *stepEffortRun) takeEffect() *agent.EffortEffect {
	r.effectsMu.Lock()
	defer r.effectsMu.Unlock()
	return r.pending
}

func (r *stepEffortRun) clearEffect() {
	r.effectsMu.Lock()
	defer r.effectsMu.Unlock()
	r.pending = nil
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
// Called after the run-level tag, overriding its metadata for this step.
func (r *stepEffortRun) tagStep(msg agent.Message, firstOfRequest bool) agent.Message {
	if msg.ParentToolUseID != "" {
		return msg
	}
	effect := r.takeEffect()
	if effect == nil {
		return msg
	}
	if !firstOfRequest && msg.Type != agent.MessageThinking {
		return msg
	}
	if !firstOfRequest {
		// A thinking message of the same step: keep the effect pending for
		// the step's first message, which may not have arrived yet.
		r.pending = effect
		if msg.Metadata == nil || msg.Metadata["thinking"] == nil {
			return msg
		}
	}
	msg.Metadata = maps.Clone(msg.Metadata)
	if msg.Metadata == nil {
		msg.Metadata = map[string]any{}
	}
	msg.Metadata["thinking"] = effectMetadata(*effect)
	if firstOfRequest {
		r.clearEffect()
	}
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
	feature, repeats := r.Errors.Observe(req.ErrorText)
	lastTool := len(req.Tools) - 1
	input := StepThinkingInput{
		Step:           req.Step,
		Goal:           r.Goal,
		AssistantText:  req.AssistantText,
		ErrorFeatures:  feature,
		RepeatedErrors: repeats,
	}
	if lastTool >= 0 {
		tool := req.Tools[lastTool]
		input.ToolName = tool.Name
		input.ToolInputSummary = tool.InputSummary
		input.ToolResult = tool.ResultText
		input.ToolIsError = tool.IsError
	}
	return ThinkingRequest(BuildStepThinkingState(input), r.Candidates), input
}

// decide answers one step: a level from Jev, a fallback reason, or "not
// enabled". Falls back (never errors the run) on any failure.
func (r *stepEffortRun) decide(ctx context.Context, req thinkingDecisionRequest, log interface {
	Info(string, ...any)
	Warn(string, ...any)
}) thinkingDecisionResponse {
	if !r.enabledNow() {
		var disabled bool
		return thinkingDecisionResponse{Enabled: &disabled}
	}
	if req.Step < 1 {
		return thinkingDecisionResponse{Fallback: string(jev.ReasonInvalid)}
	}
	jevReq, _ := r.buildStepRequest(req)
	trace := r.Trace
	trace.Step = req.Step
	record := decideThinking(ctx, r.Clients, trace, jevReq)
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
			d.writeRepoCheckoutAuthError(w, authResult)
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
		writeThinkingDecision(w, run.decide(ctx, req, d.logger))
	}
}

func writeThinkingDecision(w http.ResponseWriter, resp thinkingDecisionResponse) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// prepareStepEffort is the daemon-side gate for the per-step effort mod
// (contract §6): provider, _adapt request, a landed run-level level, CLI
// version, and ≥2 candidates all have to hold. It loads the model catalog,
// installs the mod, and returns the environment for it; nil means the run
// stays run-level only, with nothing written.
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
	if startupEffort == "" {
		// The run-level decision fell back; there is no level to carry.
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	catalog, err := listModels(ctx, provider, runtimeCmd)
	if err != nil {
		log.Info("thinking_level: catalog unavailable; step effort off", "error", err)
		return nil
	}
	existing := agentEnv[yskPluginDirsEnv]
	if existing == "" {
		existing = os.Getenv(yskPluginDirsEnv)
	}
	return d.registerStepEffortRun(task, provider, model, cliVersion, requestedLevel, startupEffort, catalog, env.MulticaConfigRoot, existing)
}

// registerStepEffortRun installs a step-effort run for a task that passed the
// contract §6 gates, and returns the env that loads the mod. startupEffort is
// the run-level decision's level. Returns nil when the mod should not load —
// run-level effort still applies.
func (d *Daemon) registerStepEffortRun(task Task, provider, model, cliVersion, thinkingLevel, startupEffort string, catalog agent.Catalog, configRoot string, existingPluginDirs string) map[string]string {
	if provider != "claude" || thinkingLevel != agent.ThinkingLevelAdapt {
		return nil
	}
	if !agent.SupportsClaudePerTurnEffort(cliVersion) {
		d.logger.Info("thinking_level: Claude Code is too old for per-step effort; run-level only",
			"claude_version", cliVersion, "minimum", agent.ClaudePerTurnEffortMinVersion)
		return nil
	}
	if startupEffort == "" {
		// No run-level level either (fallback): nothing to adapt from.
		return nil
	}
	candidates := agent.ModelAdaptThinkingCandidates(catalog, provider, model)
	if len(candidates) < 2 {
		return nil
	}
	paths := effortmod.PathsFor(configRoot)
	vars, err := effortmod.Install(configRoot, effortmod.EffortContext{
		Version:       1,
		TaskID:        task.ID,
		Endpoint:      fmt.Sprintf("/tasks/%s/thinking-decision", task.ID),
		StartupEffort: startupEffort,
	})
	if err != nil {
		d.logger.Warn("thinking_level: effort mod not installed; run-level only", "error", err)
		return nil
	}
	d.stepEffort.add(&stepEffortRun{
		TaskID:      task.ID,
		Provider:    provider,
		Model:       model,
		Clients:     d.jevClient,
		Trace:       ThinkingDecisionTrace{TaskID: task.ID, Scope: "step", Provider: provider, Model: model},
		Goal:        BuildRunThinkingState(task, provider, model),
		Candidates:  candidates,
		EnabledPath: paths.EnabledFile,
	})
	vars[yskPluginDirsEnv] = effortmod.MergePluginDir(existingPluginDirs, paths.Plugin)
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
