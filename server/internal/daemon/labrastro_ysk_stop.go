package daemon

import (
	"context"
	"log/slog"
	"os"
	"sync"

	"github.com/multica-ai/multica/server/internal/daemon/ysk"
)

type youShouldKnowStopKey struct{}

// Shared only by one run's poller and mod installer. Polling starts before the
// environment is prepared, so remember a shutdown even before the file path is
// available. Re-enabling the workspace never restarts YSK in this run.
type youShouldKnowStop struct {
	mu       sync.Mutex
	path     string
	disabled bool
	written  bool
}

func withYouShouldKnowStop(ctx context.Context, task Task) context.Context {
	if len(task.YouShouldKnow) == 0 {
		return ctx
	}
	return context.WithValue(ctx, youShouldKnowStopKey{}, &youShouldKnowStop{})
}

func registerYouShouldKnowStop(ctx context.Context, configRoot string, logger *slog.Logger) {
	stop, _ := ctx.Value(youShouldKnowStopKey{}).(*youShouldKnowStop)
	if stop == nil {
		return
	}
	stop.mu.Lock()
	defer stop.mu.Unlock()
	stop.path = ysk.PathsFor(configRoot).Stop
	stop.write(logger)
}

// Detach before the environment lock is released: later tasks may reuse the
// same config root while the old handleTask is still reporting completion.
func unregisterYouShouldKnowStop(ctx context.Context) {
	stop, _ := ctx.Value(youShouldKnowStopKey{}).(*youShouldKnowStop)
	if stop == nil {
		return
	}
	stop.mu.Lock()
	defer stop.mu.Unlock()
	stop.path = ""
}

func updateYouShouldKnowStop(ctx context.Context, enabled *bool, logger *slog.Logger) {
	stop, _ := ctx.Value(youShouldKnowStopKey{}).(*youShouldKnowStop)
	if stop == nil {
		return
	}
	stop.mu.Lock()
	defer stop.mu.Unlock()
	if enabled != nil && !*enabled {
		stop.disabled = true
	}
	stop.write(logger)
}

// Caller holds mu. Only a successfully installed mod registers a path. Retry a
// failed write on the next poll, without interrupting the task; after success
// there is no more filesystem I/O, even if the workspace is enabled again.
func (s *youShouldKnowStop) write(logger *slog.Logger) {
	if !s.disabled || s.path == "" || s.written {
		return
	}
	if err := os.WriteFile(s.path, nil, 0o600); err != nil {
		logger.Warn("you-should-know: stop marker write failed; will retry", "error", err)
		return
	}
	s.written = true
}
