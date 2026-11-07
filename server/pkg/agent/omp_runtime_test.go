package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

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
		AdvisorEnabled:    true,
		AdvisorReviewMode: "agent-end",
		ExecutionMode:     "plan_yolo",
	}
	if *full != *want {
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
	if degraded.AdvisorReviewMode != "" || degraded.ExecutionMode != "" || degraded.SmolModel != "" || !degraded.AdvisorEnabled {
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
		AdvisorEnabled:    true,
		AdvisorReviewMode: "agent-end",
		ExecutionMode:     "plan_yolo",
	}}
	args := buildOmpArgs("", dir, opts, slog.Default())
	overlay := filepath.Join(dir, ompAdvisorOverlayName)
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
	if string(data) != "advisor:\n  reviewMode: agent-end\n" {
		t.Fatalf("advisor overlay content = %q", data)
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
		AdvisorEnabled:    true,
		AdvisorReviewMode: "turn",
	}}, slog.Default())
	if i := slices.Index(adv, "--config"); i < 0 || adv[i+1] != filepath.Join(filepath.Dir(resume), ompAdvisorOverlayName) {
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
			AdvisorEnabled: true,
		},
		CustomArgs: []string{
			"--smol=kimi-code/k2.5",         // inline-value form wins
			"--plan-yolo-into", "openai/gpt-6-astra", // separate-value form wins
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

func TestPrepareOmpAdvisorOverlaySkips(t *testing.T) {
	if path, err := prepareOmpAdvisorOverlay("", "", nil); err != nil || path != "" {
		t.Fatalf("nil opts: %q, %v", path, err)
	}
	if path, err := prepareOmpAdvisorOverlay("", t.TempDir(), &OmpRuntimeOpts{AdvisorEnabled: true}); err != nil || path != "" {
		t.Fatalf("advisor without review mode must not write an overlay: %q, %v", path, err)
	}
}
