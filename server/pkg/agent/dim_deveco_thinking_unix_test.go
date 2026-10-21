//go:build !windows

package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// dim effort-catalog discovery tests. The stub shape mirrors reasonixStubFor:
// a POSIX shell answering initialize and session/new, which is all model
// discovery drives. Only the session/new result differs per case.

// dimSessionResultWithThoughtLevel mirrors dim (dimcode 0.3.10+) session/new:
// the models block plus a `thought_level` configOption whose option id is
// `thought_level` (not reasonix's `effort`), exercising the id-side of
// acpEffortOptionIDs.
const dimSessionResultWithThoughtLevel = `{"sessionId":"ses_dim",` +
	`"models":{"currentModelId":"dim/model-a","availableModels":[` +
	`{"modelId":"dim/model-a","name":"Model A"},{"modelId":"dim/model-b","name":"Model B"}]},` +
	`"configOptions":[` +
	`{"type":"select","id":"permission","currentValue":"full-access"},` +
	`{"type":"select","id":"mode","currentValue":"agent"},` +
	`{"type":"select","id":"thought_level","name":"Thought level","category":"thought_level","currentValue":"high","options":[` +
	`{"value":"auto","name":"Auto"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]}`

const dimSessionResultWithoutThoughtLevel = `{"sessionId":"ses_dim",` +
	`"models":{"currentModelId":"dim/model-a","availableModels":[` +
	`{"modelId":"dim/model-a","name":"Model A"},{"modelId":"dim/model-b","name":"Model B"}]},` +
	`"configOptions":[` +
	`{"type":"select","id":"permission","currentValue":"full-access"},` +
	`{"type":"select","id":"mode","currentValue":"agent"}]}`

// TestDiscoverDimModelsAnnotatesThoughtLevel: the same handshake that yields
// the catalog must also yield the effort selector for the session's current
// model, and no other.
func TestDiscoverDimModelsAnnotatesThoughtLevel(t *testing.T) {
	t.Parallel()
	fakePath := filepath.Join(t.TempDir(), "dim")
	writeTestExecutable(t, fakePath, []byte(reasonixStubFor(dimSessionResultWithThoughtLevel)))

	models, err := discoverDimModels(context.Background(), Command{Path: fakePath})
	if err != nil {
		t.Fatalf("discoverDimModels: %v", err)
	}
	if err == nil && len(models.Models) != 2 {
		t.Fatalf("models = %+v, want 2", models.Models)
	}

	byID := map[string]Model{}
	for _, m := range models.Models {
		byID[m.ID] = m
	}
	current := byID["dim/model-a"]
	if current.Thinking == nil {
		t.Fatal("the session's current model must carry the advertised thought_level catalog")
	}
	if got := len(current.Thinking.SupportedLevels); got != 3 {
		t.Errorf("current model levels = %+v, want the 3 advertised", current.Thinking.SupportedLevels)
	}
	if current.Thinking.DefaultLevel != "high" {
		t.Errorf("DefaultLevel = %q, want high (the advertised currentValue)", current.Thinking.DefaultLevel)
	}
	if other := byID["dim/model-b"]; other.Thinking != nil {
		t.Errorf("model %q inherited %+v; only the current model was described", other.ID, other.Thinking)
	}
}

// TestDiscoverDimModelsNoThoughtLevelNoCatalog: no advertised dial means no
// picker — for every model, not just the current one.
func TestDiscoverDimModelsNoThoughtLevelNoCatalog(t *testing.T) {
	t.Parallel()
	fakePath := filepath.Join(t.TempDir(), "dim")
	writeTestExecutable(t, fakePath, []byte(reasonixStubFor(dimSessionResultWithoutThoughtLevel)))

	catalog, err := discoverDimModels(context.Background(), Command{Path: fakePath})
	if err != nil {
		t.Fatalf("discoverDimModels: %v", err)
	}
	for _, m := range catalog.Models {
		if m.Thinking != nil {
			t.Errorf("model %q got %+v with no thought_level advertised", m.ID, m.Thinking)
		}
	}
}

// TestValidateThinkingLevelDim covers the daemon's pre-execution guard: a
// discovered catalog accepts the advertised levels and rejects everything
// else, for both the current model and (fail-closed) unknown models.
func TestValidateThinkingLevelDim(t *testing.T) {
	t.Parallel()
	fakePath := filepath.Join(t.TempDir(), "dim")
	writeTestExecutable(t, fakePath, []byte(reasonixStubFor(dimSessionResultWithThoughtLevel)))

	for _, tc := range []struct {
		model string
		level string
		want  bool
	}{
		{model: "dim/model-a", level: "high", want: true},
		{model: "dim/model-a", level: "max", want: true},
		{model: "dim/model-a", level: "auto", want: true},
		{model: "dim/model-a", level: "ultra", want: false},
		{model: "", level: "max", want: true}, // empty resolves to the catalog's Default
		{model: "dim/model-b", level: "high", want: false},
		{model: "no-such-model", level: "high", want: false},
	} {
		got, err := ValidateThinkingLevel(context.Background(), "dim", Command{Path: fakePath}, tc.model, tc.level)
		if err != nil {
			t.Fatalf("ValidateThinkingLevel(%q, %q): %v", tc.model, tc.level, err)
		}
		if got != tc.want {
			t.Errorf("ValidateThinkingLevel(%q, %q) = %v, want %v", tc.model, tc.level, got, tc.want)
		}
	}
}

// ── DevEco ───────────────────────────────────────────────────────────

// fakeDevecoModelsScript answers `models --verbose` with deveco/ rows plus
// per-model JSON carrying variants, mirroring the OpenCode-engine output the
// real CLI prints (see deveco_models.go's file comment).
func fakeDevecoModelsScript(t *testing.T, verbose, plain string) string {
	t.Helper()
	dir := t.TempDir()
	verboseFile := filepath.Join(dir, "verbose.txt")
	plainFile := filepath.Join(dir, "plain.txt")
	if err := os.WriteFile(verboseFile, []byte(verbose), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plainFile, []byte(plain), 0o644); err != nil {
		t.Fatal(err)
	}
	return "#!/bin/sh\n" +
		"if [ \"$1\" = \"models\" ] && [ \"$2\" = \"--verbose\" ]; then\n" +
		"  cat " + verboseFile + "\n" +
		"  exit 0\n" +
		"fi\n" +
		"if [ \"$1\" = \"models\" ]; then\n" +
		"  cat " + plainFile + "\n" +
		"  exit 0\n" +
		"fi\n" +
		"exit 1\n"
}

// TestDiscoverDevecoModelsParsesVariants: the verbose catalog's variants map
// becomes the thinking-level picker for each model, and unknown ones stay off.
func TestDiscoverDevecoModelsParsesVariants(t *testing.T) {
	t.Parallel()
	verbose := `deveco/glm-5
{
  "id": "glm-5",
  "name": "GLM-5",
  "reasoning": true,
  "variants": {
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
deveco/Qwen2.5-VL-72B
{
  "id": "Qwen2.5-VL-72B",
  "name": "Qwen2.5-VL-72B",
  "reasoning": false
}
`
	plain := "deveco/glm-5\ndeveco/Qwen2.5-VL-72B\n"
	fakePath := filepath.Join(t.TempDir(), "deveco")
	writeTestExecutable(t, fakePath, []byte(fakeDevecoModelsScript(t, verbose, plain)))

	models, err := discoverDevecoModels(context.Background(), Command{Path: fakePath})
	if err != nil {
		t.Fatalf("discoverDevecoModels: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %+v, want 2", models)
	}
	if models[0].ID != "deveco/glm-5" || models[0].Thinking == nil {
		t.Fatalf("glm-5 must carry variants: %+v", models[0].Thinking)
	}
	got := make([]string, 0, len(models[0].Thinking.SupportedLevels))
	for _, lvl := range models[0].Thinking.SupportedLevels {
		got = append(got, lvl.Value)
	}
	if strings.Join(got, ",") != "high,max" {
		t.Errorf("glm-5 levels = %v, want [high max]", got)
	}
	if models[1].Thinking != nil {
		t.Errorf("non-reasoning model must not get a picker: %+v", models[1].Thinking)
	}
}

// TestDiscoverDevecoModelsFallsBackToPlain: when --verbose yields nothing
// (unsupported flag, noise), the plain command still lists the models —
// without variants.
func TestDiscoverDevecoModelsFallsBackToPlain(t *testing.T) {
	t.Parallel()
	plain := "deveco/glm-5\n"
	fakePath := filepath.Join(t.TempDir(), "deveco")
	writeTestExecutable(t, fakePath, []byte(fakeDevecoModelsScript(t, "verbose noise exit 1", plain)))

	models, err := discoverDevecoModels(context.Background(), Command{Path: fakePath})
	if err != nil {
		t.Fatalf("discoverDevecoModels: %v", err)
	}
	if len(models) != 1 || models[0].ID != "deveco/glm-5" {
		t.Fatalf("models = %+v, want the plain-catalog glm-5", models)
	}
	if models[0].Thinking != nil {
		t.Errorf("plain fallback has no variants: %+v", models[0].Thinking)
	}
}

// TestValidateThinkingLevelDeveco pins the daemon guard: the discovered
// variant catalog accepts advertised variants and rejects everything else.
func TestValidateThinkingLevelDeveco(t *testing.T) {
	t.Parallel()
	verbose := `deveco/glm-5
{
  "id": "glm-5",
  "reasoning": true,
  "variants": {
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
`
	fakePath := filepath.Join(t.TempDir(), "deveco")
	writeTestExecutable(t, fakePath, []byte(fakeDevecoModelsScript(t, verbose, "")))

	for _, tc := range []struct {
		model string
		level string
		want  bool
	}{
		{model: "deveco/glm-5", level: "high", want: true},
		{model: "deveco/glm-5", level: "max", want: true},
		{model: "deveco/glm-5", level: "low", want: false},
		{model: "no-such/model", level: "high", want: false},
	} {
		got, err := ValidateThinkingLevel(context.Background(), "deveco", Command{Path: fakePath}, tc.model, tc.level)
		if err != nil {
			t.Fatalf("ValidateThinkingLevel(%q, %q): %v", tc.model, tc.level, err)
		}
		if got != tc.want {
			t.Errorf("ValidateThinkingLevel(%q, %q) = %v, want %v", tc.model, tc.level, got, tc.want)
		}
	}
}
