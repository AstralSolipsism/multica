package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestBuildOmpArgsExplicitSettings(t *testing.T) {
	for _, tt := range []struct {
		name    string
		wire    string
		yaml    string
		advisor bool
	}{
		{"unset inherits", `{}`, "", false},
		{"null inherits", `{"advisor_enabled":null,"autolearn_enabled":null,"memory_backend":null}`, "", false},
		{"advisor off", `{"advisor_enabled":false,"advisor_review_mode":"turn","slow_model":"test/reviewer"}`, "advisor:\n  enabled: false\n", false},
		{"memory off", `{"memory_backend":"off"}`, "memory:\n  backend: off\n", false},
		{"autolearn off", `{"autolearn_enabled":false}`, "autolearn:\n  enabled: false\n", false},
		{"advisor default", `{"advisor_enabled":true}`, "advisor:\n  enabled: true\n  reviewMode: agent-end\n", true},
		{"advisor invalid cadence", `{"advisor_enabled":true,"advisor_review_mode":"invalid"}`, "advisor:\n  enabled: true\n  reviewMode: agent-end\n", true},
		{"advisor turn", `{"advisor_enabled":true,"advisor_review_mode":"turn"}`, "advisor:\n  enabled: true\n  reviewMode: turn\n", true},
		{"all off", `{"advisor_enabled":false,"memory_backend":"off","autolearn_enabled":false}`, "advisor:\n  enabled: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\n", false},
		{"mixed overrides", `{"advisor_enabled":false,"memory_backend":"mnemopi","autolearn_enabled":true}`, "advisor:\n  enabled: false\nmemory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n  embeddingVariant: multilingual\nautolearn:\n  enabled: true\n  autoContinue: true\n", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			opts := DecodeOmpRuntimeConfig(json.RawMessage(tt.wire), slog.Default())
			args := buildOmpArgs("", dir, ExecOptions{OmpRuntime: opts}, slog.Default())
			if slices.Contains(args, "--advisor") != tt.advisor || slices.Contains(args, "--slow") {
				t.Fatalf("unexpected role flags: %v", args)
			}
			overlay := filepath.Join(dir, ompSettingsOverlayName)
			if tt.yaml == "" {
				if opts != nil || slices.Contains(args, "--config") {
					t.Fatalf("unset config must inherit: opts=%+v args=%v", opts, args)
				}
				if _, err := os.Stat(overlay); !os.IsNotExist(err) {
					t.Fatalf("unset config wrote an overlay: %v", err)
				}
				return
			}
			if i := slices.Index(args, "--config"); i < 0 || args[i+1] != overlay {
				t.Fatalf("missing managed overlay flag: %v", args)
			}
			data, err := os.ReadFile(overlay)
			if err != nil || string(data) != tt.yaml {
				t.Fatalf("overlay = %q, %v; want %q", data, err, tt.yaml)
			}
		})
	}
}

func TestDecodeOmpRuntimeConfig(t *testing.T) {
	logger := slog.Default()
	if got := DecodeOmpRuntimeConfig(nil, logger); got != nil {
		t.Fatalf("empty payload: got %+v, want nil", got)
	}
	if got := DecodeOmpRuntimeConfig(json.RawMessage(`{"qoder_agent_id":"x"}`), logger); got != nil {
		t.Fatalf("unrelated payload: got %+v, want nil", got)
	}
	if got := DecodeOmpRuntimeConfig(json.RawMessage(`{"smol_model"`), logger); got != nil {
		t.Fatalf("malformed payload must fail soft: got %+v", got)
	}
	full := DecodeOmpRuntimeConfig(json.RawMessage(`{
		"smol_model":"zai/glm-5.3-flash",
		"slow_model":"openai-codex/gpt-6-astra",
		"plan_model":"openai-codex/gpt-6.1-sol",
		"handoff_model":"zai/glm-5.3",
		"advisor_enabled":true,
		"advisor_review_mode":"agent-end",
		"execution_mode":"plan_yolo"
	}`), logger)
	want := &OmpRuntimeOpts{
		SmolModel:         "zai/glm-5.3-flash",
		SlowModel:         "openai-codex/gpt-6-astra",
		PlanModel:         "openai-codex/gpt-6.1-sol",
		HandoffModel:      "zai/glm-5.3",
		AdvisorEnabled:    ompTestBool(true),
		AdvisorReviewMode: "agent-end",
		ExecutionMode:     "plan_yolo",
	}
	if !reflect.DeepEqual(full, want) {
		t.Fatalf("full payload: got %+v, want %+v", *full, *want)
	}
	// Unknown enums degrade to defaults; standard collapses to ""; flag-like
	// model tokens are dropped rather than spliced into argv.
	degraded := DecodeOmpRuntimeConfig(json.RawMessage(`{
		"advisor_enabled":true,
		"advisor_review_mode":"per-step",
		"execution_mode":"standard",
		"smol_model":"--evil"
	}`), logger)
	if degraded.AdvisorReviewMode != "" || degraded.ExecutionMode != "" || degraded.SmolModel != "" || (degraded.AdvisorEnabled == nil || !*degraded.AdvisorEnabled) {
		t.Fatalf("degraded payload: got %+v", degraded)
	}
}

func TestBuildOmpArgsRuntimeMapping(t *testing.T) {
	dir := t.TempDir()
	opts := ExecOptions{OmpRuntime: &OmpRuntimeOpts{
		SmolModel:         "zai/glm-5.3-flash",
		SlowModel:         "openai-codex/gpt-6-astra",
		PlanModel:         "openai-codex/gpt-6.1-sol",
		HandoffModel:      "zai/glm-5.3",
		AdvisorEnabled:    ompTestBool(true),
		AdvisorReviewMode: "agent-end",
		ExecutionMode:     "plan_yolo",
	}}
	args := buildOmpArgs("", dir, opts, slog.Default())
	overlay := filepath.Join(dir, ompSettingsOverlayName)
	want := []string{
		"-p", "--mode", "json", "--session-dir", dir,
		"--smol", "zai/glm-5.3-flash",
		"--slow", "openai-codex/gpt-6-astra",
		"--plan", "openai-codex/gpt-6.1-sol",
		"--advisor", "--config", overlay,
		"--plan-yolo", "--plan-yolo-into", "zai/glm-5.3",
	}
	if !slices.Equal(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
	data, err := os.ReadFile(overlay)
	if err != nil {
		t.Fatalf("advisor overlay missing: %v", err)
	}
	if string(data) != "advisor:\n  enabled: true\n  reviewMode: agent-end\n" {
		t.Fatalf("advisor overlay content = %q", data)
	}
}

func TestBuildOmpArgsOverlayWithoutAdvisor(t *testing.T) {
	// Memory or auto-learn alone must inject the settings overlay via
	// --config even when the advisor is off (review #1).
	for name, runtime := range map[string]*OmpRuntimeOpts{
		"memory only":    {MemoryBackend: "sharpshooter"},
		"autolearn only": {AutolearnEnabled: ompTestBool(true)},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			args := buildOmpArgs("", dir, ExecOptions{OmpRuntime: runtime}, slog.Default())
			overlay := filepath.Join(dir, ompSettingsOverlayName)
			want := []string{"-p", "--mode", "json", "--session-dir", dir, "--config", overlay}
			if !slices.Equal(args, want) {
				t.Fatalf("args = %v, want %v", args, want)
			}
			if _, err := os.Stat(overlay); err != nil {
				t.Fatalf("overlay missing: %v", err)
			}
		})
	}
}

func TestBuildOmpArgsGatesHiddenRoleModels(t *testing.T) {
	// A stored slow/plan value whose toggle is off must not reach argv —
	// the UI hides the selector and the quota extractor ignores it (review #3).
	dir := t.TempDir()
	args := buildOmpArgs("", dir, ExecOptions{OmpRuntime: &OmpRuntimeOpts{
		SlowModel: "openai-codex/gpt-6-astra",
		PlanModel: "anthropic/claude-opus-4.7",
	}}, slog.Default())
	want := []string{"-p", "--mode", "json", "--session-dir", dir}
	if !slices.Equal(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}

	// Advisor on routes slow; a collaborative mode routes plan.
	gated := buildOmpArgs("", dir, ExecOptions{OmpRuntime: &OmpRuntimeOpts{
		SlowModel:      "openai-codex/gpt-6-astra",
		AdvisorEnabled: ompTestBool(true),
		ExecutionMode:  "plan_yolo",
		PlanModel:      "anthropic/claude-opus-4.7",
		HandoffModel:   "zai/glm-5.3",
	}}, slog.Default())
	if !slices.Contains(gated, "--slow") || !slices.Contains(gated, "--plan") {
		t.Fatalf("enabled roles missing their flags: %v", gated)
	}
}

func TestBuildOmpArgsPrewalkAndResume(t *testing.T) {
	resume := filepath.Join(t.TempDir(), "saved.jsonl")
	opts := ExecOptions{OmpRuntime: &OmpRuntimeOpts{
		ExecutionMode: "prewalk",
		HandoffModel:  "zai/glm-5.3",
	}}
	args := buildOmpArgs(resume, "", opts, slog.Default())
	want := []string{"-p", "--mode", "json", "--session", resume,
		"--prewalk", "--prewalk-into", "zai/glm-5.3"}
	if !slices.Equal(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
	// The overlay for a resume run lands beside the transcript.
	adv := buildOmpArgs(resume, "", ExecOptions{OmpRuntime: &OmpRuntimeOpts{
		AdvisorEnabled:    ompTestBool(true),
		AdvisorReviewMode: "turn",
	}}, slog.Default())
	if i := slices.Index(adv, "--config"); i < 0 || adv[i+1] != filepath.Join(filepath.Dir(resume), ompSettingsOverlayName) {
		t.Fatalf("resume overlay path wrong: %v", adv)
	}
}

func TestBuildOmpArgsCustomArgsOverride(t *testing.T) {
	dir := t.TempDir()
	opts := ExecOptions{
		OmpRuntime: &OmpRuntimeOpts{
			SmolModel:      "zai/glm-5.3-flash",
			ExecutionMode:  "plan_yolo",
			HandoffModel:   "zai/glm-5.3",
			AdvisorEnabled: ompTestBool(true),
		},
		CustomArgs: []string{
			"--smol=kimi-code/k2.5",                  // inline-value form wins
			"--plan-yolo-into", "openai/gpt-6-astra", // separate-value form wins
			"--config=/custom/omp.yml",
			"--tools", "read",
		},
	}
	args := buildOmpArgs("", dir, opts, slog.Default())
	if slices.Contains(args, "zai/glm-5.3-flash") {
		t.Fatalf("managed --smol must yield to the explicit custom_args flag: %v", args)
	}
	if !slices.Contains(args, "--smol=kimi-code/k2.5") {
		t.Fatalf("custom --smol missing: %v", args)
	}
	if slices.Contains(args, "--config") || !slices.Contains(args, "--config=/custom/omp.yml") {
		t.Fatalf("custom settings must override the managed overlay: %v", args)
	}
	// Exactly one --plan-yolo-into: the custom_args one survives, the managed
	// twin is dropped.
	if strings.Count(strings.Join(args, " "), "--plan-yolo-into") != 1 {
		t.Fatalf("managed --plan-yolo-into must be dropped: %v", args)
	}
	if !slices.Contains(args, "--plan-yolo") || !slices.Contains(args, "--advisor") {
		t.Fatalf("non-overridden managed flags missing: %v", args)
	}
	// --no-prewalk negates the managed prewalk pair.
	prewalk := buildOmpArgs("", dir, ExecOptions{
		OmpRuntime: &OmpRuntimeOpts{ExecutionMode: "prewalk", HandoffModel: "zai/glm-5.3"},
		CustomArgs: []string{"--no-prewalk"},
	}, slog.Default())
	if slices.Contains(prewalk, "--prewalk") || slices.Contains(prewalk, "--prewalk-into") {
		t.Fatalf("--no-prewalk must negate the managed prewalk flags: %v", prewalk)
	}
}

func TestBuildOmpArgsNilRuntimeUnchanged(t *testing.T) {
	dir := t.TempDir()
	args := buildOmpArgs("", dir, ExecOptions{CustomArgs: []string{"--tools", "read"}}, slog.Default())
	want := []string{"-p", "--mode", "json", "--tools", "read", "--session-dir", dir}
	if !slices.Equal(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

func TestPrepareOmpSettingsOverlaySkips(t *testing.T) {
	if path, err := prepareOmpSettingsOverlay("", "", nil); err != nil || path != "" {
		t.Fatalf("nil opts: %q, %v", path, err)
	}
	if path, err := prepareOmpSettingsOverlay("", t.TempDir(), &OmpRuntimeOpts{AdvisorReviewMode: "turn"}); err != nil || path != "" {
		t.Fatalf("review mode without explicit advisor state must inherit: %q, %v", path, err)
	}
	if path, err := prepareOmpSettingsOverlay("", t.TempDir(), &OmpRuntimeOpts{MemoryBackend: ""}); err != nil || path != "" {
		t.Fatalf("unset memory must not write an overlay: %q, %v", path, err)
	}
}

func TestPrepareOmpSettingsOverlayMemoryAndAutolearn(t *testing.T) {
	readOverlay := func(t *testing.T, dir string) string {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(dir, ompSettingsOverlayName))
		if err != nil {
			t.Fatalf("overlay missing: %v", err)
		}
		return string(data)
	}

	t.Run("sharpshooter", func(t *testing.T) {
		dir := t.TempDir()
		path, err := prepareOmpSettingsOverlay("", dir, &OmpRuntimeOpts{MemoryBackend: "sharpshooter"})
		if err != nil || path == "" {
			t.Fatalf("overlay: %q, %v", path, err)
		}
		if got := readOverlay(t, dir); got != "memory:\n  backend: sharpshooter\n" {
			t.Fatalf("overlay = %q", got)
		}
	})

	t.Run("mnemopi", func(t *testing.T) {
		dir := t.TempDir()
		path, err := prepareOmpSettingsOverlay("", dir, &OmpRuntimeOpts{MemoryBackend: "mnemopi"})
		if err != nil || path == "" {
			t.Fatalf("overlay: %q, %v", path, err)
		}
		want := "memory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n  embeddingVariant: multilingual\n"
		if got := readOverlay(t, dir); got != want {
			t.Fatalf("overlay = %q, want %q", got, want)
		}
	})

	t.Run("autolearn and advisor combined", func(t *testing.T) {
		dir := t.TempDir()
		path, err := prepareOmpSettingsOverlay("", dir, &OmpRuntimeOpts{
			AdvisorEnabled:    ompTestBool(true),
			AdvisorReviewMode: "turn",
			AutolearnEnabled:  ompTestBool(true),
		})
		if err != nil || path == "" {
			t.Fatalf("overlay: %q, %v", path, err)
		}
		want := "advisor:\n  enabled: true\n  reviewMode: turn\nautolearn:\n  enabled: true\n  autoContinue: true\n"
		if got := readOverlay(t, dir); got != want {
			t.Fatalf("overlay = %q, want %q", got, want)
		}
	})

	t.Run("full stack rides one --config", func(t *testing.T) {
		dir := t.TempDir()
		args := buildOmpArgs("", dir, ExecOptions{OmpRuntime: &OmpRuntimeOpts{
			AdvisorEnabled:    ompTestBool(true),
			AdvisorReviewMode: "agent-end",
			MemoryBackend:     "mnemopi",
			AutolearnEnabled:  ompTestBool(true),
		}}, slog.Default())
		if strings.Count(strings.Join(args, " "), "--config") != 1 {
			t.Fatalf("expected exactly one --config: %v", args)
		}
	})
}

func TestDecodeOmpRuntimeConfigMemory(t *testing.T) {
	logger := slog.Default()
	cfg := DecodeOmpRuntimeConfig(json.RawMessage(`{
		"memory_backend":"mnemopi",
		"autolearn_enabled":true
	}`), logger)
	if cfg == nil || cfg.MemoryBackend != "mnemopi" || (cfg.AutolearnEnabled == nil || !*cfg.AutolearnEnabled) {
		t.Fatalf("decode: %+v", cfg)
	}
	// Explicit off values survive decoding; unknown backends inherit.
	off := DecodeOmpRuntimeConfig(json.RawMessage(`{"memory_backend":"off","autolearn_enabled":false}`), logger)
	if off == nil || off.MemoryBackend != "off" || off.AutolearnEnabled == nil || *off.AutolearnEnabled {
		t.Fatalf("explicit off values lost: %+v", off)
	}
	bad := DecodeOmpRuntimeConfig(json.RawMessage(`{"memory_backend":"sqlite"}`), logger)
	if bad != nil {
		t.Fatalf("unknown memory_backend must degrade to nil: %+v", bad)
	}
}

func TestOmpSettingsOverlayReplacedOnResume(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "saved.jsonl")
	if err := os.WriteFile(transcript, []byte("saved transcript\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	on := DecodeOmpRuntimeConfig(json.RawMessage(`{"advisor_enabled":true,"memory_backend":"mnemopi","autolearn_enabled":true}`), nil)
	buildOmpArgs("", dir, ExecOptions{OmpRuntime: on}, nil)
	off := DecodeOmpRuntimeConfig(json.RawMessage(`{"advisor_enabled":false,"memory_backend":"off","autolearn_enabled":false}`), nil)
	args := buildOmpArgs(transcript, "", ExecOptions{OmpRuntime: off}, nil)
	overlay := filepath.Join(dir, ompSettingsOverlayName)
	if i := slices.Index(args, "--config"); i < 0 || args[i+1] != overlay {
		t.Fatalf("resume must use the replacement overlay: %v", args)
	}
	data, err := os.ReadFile(overlay)
	if err != nil || string(data) != "advisor:\n  enabled: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\n" {
		t.Fatalf("resume retained enabled settings: %q, %v", data, err)
	}
	args = buildOmpArgs(transcript, "", ExecOptions{}, nil)
	if slices.Contains(args, "--config") {
		t.Fatalf("cleared overrides must not reuse an old overlay: %v", args)
	}
	data, err = os.ReadFile(transcript)
	if err != nil || string(data) != "saved transcript\n" {
		t.Fatalf("transcript changed: %q, %v", data, err)
	}
}

func ompTestBool(value bool) *bool { return &value }
