package agent

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// OmpRuntimeOpts is the omp-specific schema the daemon expects under an omp
// agent's `runtime_config` JSONB column (OL-1261). All fields are optional;
// absence keeps the historical launch behaviour. The frontend mirror lives in
// packages/core/agents/omp-runtime-config.ts — keep both sides in lockstep
// when changing field names.
type OmpRuntimeOpts struct {
	SmolModel         string `json:"smol_model"`
	SlowModel         string `json:"slow_model"`
	PlanModel         string `json:"plan_model"`
	HandoffModel      string `json:"handoff_model"`
	AdvisorEnabled    bool   `json:"advisor_enabled"`
	AdvisorReviewMode string `json:"advisor_review_mode"` // "" | "turn" | "agent-end"
	ExecutionMode     string `json:"execution_mode"`      // "" | "standard" | "plan_yolo" | "prewalk"
	MemoryBackend     string `json:"memory_backend"`      // "" | "off" | "sharpshooter" | "mnemopi"
	AutolearnEnabled  bool   `json:"autolearn_enabled"`
}

// DecodeOmpRuntimeConfig extracts the omp-specific knobs from an agent's
// runtime_config payload. Nil (empty payload, no omp keys, or a parse
// failure) means "launch exactly as before" — a broken blob must never block
// dispatch, mirroring decodeOpenclawRuntimeConfig's fail-soft contract.
// Unrecognized enum values and values that could smuggle a flag-looking
// token into argv are dropped with a warning.
func DecodeOmpRuntimeConfig(raw json.RawMessage, logger *slog.Logger) *OmpRuntimeOpts {
	if len(raw) == 0 {
		return nil
	}
	var cfg OmpRuntimeOpts
	if err := json.Unmarshal(raw, &cfg); err != nil {
		if logger != nil {
			logger.Warn("omp runtime_config: parse failed; ignoring OMP-specific settings", "error", err)
		}
		return nil
	}
	cfg.SmolModel = ompModelArg(cfg.SmolModel, logger)
	cfg.SlowModel = ompModelArg(cfg.SlowModel, logger)
	cfg.PlanModel = ompModelArg(cfg.PlanModel, logger)
	cfg.HandoffModel = ompModelArg(cfg.HandoffModel, logger)
	switch cfg.AdvisorReviewMode {
	case "", "turn", "agent-end":
	default:
		if logger != nil {
			logger.Warn("omp runtime_config: unrecognized advisor_review_mode; using OMP default", "value", cfg.AdvisorReviewMode)
		}
		cfg.AdvisorReviewMode = ""
	}
	switch cfg.ExecutionMode {
	case "", "standard":
		cfg.ExecutionMode = ""
	case "plan_yolo", "prewalk":
	default:
		if logger != nil {
			logger.Warn("omp runtime_config: unrecognized execution_mode; using standard", "value", cfg.ExecutionMode)
		}
		cfg.ExecutionMode = ""
	}
	switch cfg.MemoryBackend {
	case "", "off":
		cfg.MemoryBackend = ""
	case "sharpshooter", "mnemopi":
	default:
		if logger != nil {
			logger.Warn("omp runtime_config: unrecognized memory_backend; using off", "value", cfg.MemoryBackend)
		}
		cfg.MemoryBackend = ""
	}
	if cfg == (OmpRuntimeOpts{}) {
		return nil
	}
	return &cfg
}

// ompModelArg trims a role-model selector and refuses tokens that would be
// re-parsed as a flag once they land on OMP's argv (a leading dash). Model
// ids never start with one, so this only drops malformed input.
func ompModelArg(value string, logger *slog.Logger) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "-") {
		if logger != nil {
			logger.Warn("omp runtime_config: model value looks like a flag, dropping", "value", value)
		}
		return ""
	}
	return value
}

// ompFlag is one managed OMP launch flag; value == "" means boolean form.
type ompFlag struct {
	name  string
	value string
}

// flags maps the decoded config onto OMP launch flags:
//
//	--smol/--slow/--plan <id>   role model routing
//	--advisor                   advisor second-opinion reviewer
//	--config <overlay>          advisor review cadence (written per run)
//	--plan-yolo[---into <id>]   headless plan then handoff execution
//	--prewalk[---into <id>]     todo-first then handoff execution
func (o *OmpRuntimeOpts) flags(advisorConfigPath string) []ompFlag {
	if o == nil {
		return nil
	}
	var out []ompFlag
	if o.SmolModel != "" {
		out = append(out, ompFlag{"--smol", o.SmolModel})
	}
	if o.SlowModel != "" {
		out = append(out, ompFlag{"--slow", o.SlowModel})
	}
	if o.PlanModel != "" {
		out = append(out, ompFlag{"--plan", o.PlanModel})
	}
	if o.AdvisorEnabled {
		out = append(out, ompFlag{"--advisor", ""})
		if advisorConfigPath != "" {
			out = append(out, ompFlag{"--config", advisorConfigPath})
		}
	}
	switch o.ExecutionMode {
	case "plan_yolo":
		out = append(out, ompFlag{"--plan-yolo", ""})
		if o.HandoffModel != "" {
			out = append(out, ompFlag{"--plan-yolo-into", o.HandoffModel})
		}
	case "prewalk":
		out = append(out, ompFlag{"--prewalk", ""})
		if o.HandoffModel != "" {
			out = append(out, ompFlag{"--prewalk-into", o.HandoffModel})
		}
	}
	return out
}

// ompProvidedFlags collects the flag names present in a custom_args slice,
// accepting both `--flag value` and `--flag=value` spellings.
func ompProvidedFlags(args []string) map[string]bool {
	provided := make(map[string]bool, len(args))
	for _, arg := range args {
		arg = unshellQuoteArg(arg)
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			continue
		}
		name := arg
		if idx := strings.Index(arg, "="); idx > 0 {
			name = arg[:idx]
		}
		provided[name] = true
	}
	return provided
}

// appendOmpRuntimeArgs appends the managed OMP flags the user did not
// already provide in custom_args — an explicit custom_args flag is the
// override and wins over the managed twin. `--no-prewalk` additionally
// negates the managed prewalk pair, matching OMP's own negation flag.
func appendOmpRuntimeArgs(args []string, opts *OmpRuntimeOpts, advisorConfigPath string, customArgs []string) []string {
	provided := ompProvidedFlags(customArgs)
	for _, f := range opts.flags(advisorConfigPath) {
		if provided[f.name] {
			continue
		}
		if (f.name == "--prewalk" || f.name == "--prewalk-into") && provided["--no-prewalk"] {
			continue
		}
		args = append(args, f.name)
		if f.value != "" {
			args = append(args, f.value)
		}
	}
	return args
}

// ompSettingsOverlayName is the OMP settings-overlay file the daemon writes
// per run to carry managed settings (advisor review cadence, memory backend,
// auto-learn). --config is repeatable in OMP and later overlays override
// earlier ones; a dedicated run-scoped file keeps the managed settings
// isolated from user overlays.
const ompSettingsOverlayName = "multica-advisor-overlay.yml"

// prepareOmpSettingsOverlay writes the run-scoped OMP settings overlay into
// the task-private session directory (fresh runs) or next to the resumed
// transcript (resume runs), so it dies with the session and needs no explicit
// cleanup. Returns "" when no overlay applies.
func prepareOmpSettingsOverlay(sessionPath, sessionDir string, opts *OmpRuntimeOpts) (string, error) {
	if !ompSettingsOverlayApplies(opts) {
		return "", nil
	}
	dir := sessionDir
	if dir == "" {
		if sessionPath == "" {
			return "", nil
		}
		dir = filepath.Dir(sessionPath)
	}
	path := filepath.Join(dir, ompSettingsOverlayName)
	content := ompSettingsOverlayYAML(opts)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", fmt.Errorf("omp settings overlay: %w", err)
	}
	return path, nil
}

// ompSettingsOverlayApplies reports whether any managed setting needs the
// overlay: advisor review cadence, a non-off memory backend, or auto-learn.
func ompSettingsOverlayApplies(opts *OmpRuntimeOpts) bool {
	if opts == nil {
		return false
	}
	return (opts.AdvisorEnabled && opts.AdvisorReviewMode != "") ||
		opts.MemoryBackend != "" || opts.AutolearnEnabled
}

// ompSettingsOverlayYAML renders the overlay body. Values are fixed enums or
// booleans from the decoded config, never user free text, so plain string
// concatenation is safe YAML here.
func ompSettingsOverlayYAML(opts *OmpRuntimeOpts) string {
	var b strings.Builder
	if opts.AdvisorEnabled && opts.AdvisorReviewMode != "" {
		b.WriteString("advisor:\n  reviewMode: " + opts.AdvisorReviewMode + "\n")
	}
	switch opts.MemoryBackend {
	case "sharpshooter":
		b.WriteString("memory:\n  backend: sharpshooter\n")
	case "mnemopi":
		b.WriteString("memory:\n  backend: mnemopi\n")
		b.WriteString("mnemopi:\n  scoping: per-project-tagged\n  embeddingVariant: multilingual\n")
	}
	if opts.AutolearnEnabled {
		b.WriteString("autolearn:\n  enabled: true\n  autoContinue: true\n")
	}
	return b.String()
}
