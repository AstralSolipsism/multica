package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/internal/daemon/ysk"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// Labrastro "You should know" (OL-187): the daemon loads the labrastro-ysk mod
// into a Claude task when the claim asks for it, and forwards the tips the mod
// produces. Neither step may affect the task itself.

const youShouldKnowReportTimeout = time.Minute

var youShouldKnowReportRetry = []time.Duration{time.Second, 3 * time.Second}

// prepareYouShouldKnow installs the mod when the claim carries
// `you_should_know` and the local Claude Code can run it, adding the variables
// that load it to agentEnv. It reports whether the mod is in; when it is not,
// nothing was written and agentEnv is unchanged.
func prepareYouShouldKnow(task Task, provider, cliVersion string, env *execenv.Environment, agentEnv map[string]string, logger *slog.Logger) bool {
	if provider != "claude" || len(task.YouShouldKnow) == 0 || env == nil || env.MulticaConfigRoot == "" {
		return false
	}
	if !agent.SupportsClaudeYouShouldKnow(cliVersion) {
		logger.Info("you-should-know: Claude Code is too old for the tips mod; running without it",
			"claude_version", cliVersion, "minimum", agent.ClaudeYouShouldKnowMinVersion)
		return false
	}
	existing, ok := agentEnv[ysk.PluginDirsEnv]
	if !ok {
		existing = os.Getenv(ysk.PluginDirsEnv)
	}
	vars, err := ysk.Install(env.MulticaConfigRoot, task.YouShouldKnow, existing)
	if err != nil {
		logger.Warn("you-should-know: tips mod not installed; running without it", "error", err)
		return false
	}
	for key, value := range vars {
		agentEnv[key] = value
	}
	return true
}

// youShouldKnowReporter returns the ExecOptions.OnYouShouldKnow callback for
// a task: each batch is posted on its own goroutine, so the stream reader
// never waits, and a failed post is only logged.
func (d *Daemon) youShouldKnowReporter(taskID string, logger *slog.Logger) func(json.RawMessage) {
	return func(batch json.RawMessage) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), youShouldKnowReportTimeout)
			defer cancel()
			if err := d.client.ReportTaskTips(ctx, taskID, batch); err != nil {
				logger.Warn("you-should-know: tips report failed", "error", err)
			}
		}()
	}
}

// ReportTaskTips posts one labrastro-ysk batch, as the mod wrote it, to the
// task's tips endpoint (OL-187 section 13 E).
func (c *Client) ReportTaskTips(ctx context.Context, taskID string, batch json.RawMessage) error {
	path := fmt.Sprintf("/api/daemon/tasks/%s/tips", url.PathEscape(taskID))
	return c.postJSONWithRetry(ctx, path, batch, nil, youShouldKnowReportRetry)
}
