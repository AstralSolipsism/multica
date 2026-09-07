package agent

import (
	"log/slog"
	"runtime"
	"testing"
	"time"
)

func TestReviewPR11QuotaOnlyScanPreservesLiveCachedUsage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fixture is POSIX-only")
	}
	fakePath := writeFakeCodexAppServer(t, `
read line
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read line
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"cache-thread"}}}'
read line
mkdir -p "$CODEX_HOME/sessions"
echo '{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":42,"window_minutes":300}}}}' > "$CODEX_HOME/sessions/rollout-review-cache-thread.jsonl"
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
echo '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"cache-thread","turn":{"id":"cache-turn"}}}'
echo '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"cache-thread","turn":{"id":"cache-turn","status":"completed","usage":{"input_tokens":500,"cached_input_tokens":500,"output_tokens":0}}}}'
`)
	result, _ := executeFakeCodexCollectingMessagesWithConfig(t, fakePath, Config{
		Logger: slog.Default(),
		Env: map[string]string{"CODEX_HOME": t.TempDir()},
	}, ExecOptions{
		Model: "test-model",
		Cwd: t.TempDir(),
		Timeout: 5*time.Second,
		SemanticInactivityTimeout: 5*time.Second,
	}, 10*time.Second)
	if result.Status != "completed" {
		t.Fatalf("expected completed fixture, got %+v", result)
	}
	if got := result.Usage["test-model"].CacheReadTokens; got != 500 {
		t.Fatalf("live cached tokens = %d, want 500; scan only carried quota: usage=%+v quota=%+v", got, result.Usage, result.PlanQuota)
	}
}
