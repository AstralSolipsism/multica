package agent

// DevEco Code model discovery. Self-contained and independent of the OpenCode
// model backend: DevEco maintains its own CLI and catalog, so its discovery
// code lives here rather than reusing the OpenCode backend. A missing CLI or
// empty catalog returns an empty list so the caller (the runtime model picker)
// falls back to manual model entry instead of erroring.
//
// The output FORMAT, however, is inherited: DevEco is built on the OpenCode
// engine and its `deveco models` command is the same implementation (verified
// against the deveco-code source, packages/opencode/src/cli/cmd/models.ts),
// printing `provider/model` rows plus, with --verbose, a per-model JSON object.
// That object's `variants` map is exactly what `deveco run --variant` consumes
// (the engine merges variants[model.variant] into the LLM request options —
// request.ts in deveco-code; an unknown variant is a silent no-op, not an
// error), so the shared OpenCode parser maps it onto the thinking-level
// picker the same way opencode's own variants do.

import (
	"context"
	"os/exec"
	"time"
)

// discoverDevecoModels enumerates the `deveco models` catalog. It shells out to
// the DevEco Code CLI and parses `provider/model` rows, trying `--verbose`
// first so per-model variants reach the thinking-level picker (see the file
// comment). Discovery failures (binary missing, non-zero exit, unparseable
// output) silently yield an empty list so model selection degrades to manual
// entry rather than blocking.
func discoverDevecoModels(ctx context.Context, runtimeCmd Command) ([]Model, error) {
	if runtimeCmd.Path == "" {
		runtimeCmd.Path = "deveco"
	}
	if _, err := exec.LookPath(runtimeCmd.Path); err != nil {
		return []Model{}, nil
	}
	// `deveco models` may sync its hosted catalog over the network on first
	// run; allow a generous timeout so the picker isn't empty on a cold start.
	runCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Verbose first: parse whatever it printed even on a non-zero exit, and
	// fall back to the plain command when it yields nothing — the same shape
	// as the opencode path (a stale config entry can exit non-zero while
	// still listing the resolvable catalog).
	cmd := runtimeCmd.exec(runCtx, "models", "--verbose")
	hideAgentWindow(cmd)
	out, _ := outputOwned(cmd, runtimeCmd.logger)
	models := parseOpenCodeModels(string(out))
	if len(models) == 0 {
		cmd = runtimeCmd.exec(runCtx, "models")
		hideAgentWindow(cmd)
		out, _ := outputOwned(cmd, runtimeCmd.logger)
		models = parseOpenCodeModels(string(out))
	}
	if len(models) == 0 {
		return []Model{}, nil
	}
	return models, nil
}
