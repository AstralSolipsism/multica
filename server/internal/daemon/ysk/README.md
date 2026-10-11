# labrastro-ysk

The Claude Code mod behind "You should know" (OL-187): short tips for the
people watching an agent work. The interface contract is OL-187 section 13.

## Flow

1. The server adds `you_should_know` to a claim when the workspace has the
   feature on and the daemon advertises `you-should-know-v1` (13 A, B).
2. For a Claude task on Claude Code 2.1.287 or later, the daemon
   (`../labrastro_ysk.go`) writes this mod to `<task config>/ysk/plugin/`, the
   claim field as received to `<task config>/ysk/context.json`, and sets
   `CLAUDE_CODE_PLUGIN_DIRS` and `MULTICA_YSK_CONTEXT_FILE` (13 C). Otherwise
   it writes and sets nothing.
3. The mod reads the context at `session.start` and removes both variables
   from the process environment, so nothing the agent starts can find them.
4. On main-thread `turn.step`s it asks `$.model.fork` (never awaited) and logs
   each batch with `$.ui.log` (13 D). `pkg/agent/labrastro_ysk.go` takes those
   `ui_log` lines out of the stream and the daemon posts them to
   `POST /api/daemon/tasks/{taskId}/tips` (13 E). Failures are only logged.

## Timing

Measured on Claude Code 2.1.292 in the daemon's `-p` stream-json mode:

- A fork answers over the main thread's last sent request plus the text of its
  reply, tool calls removed. At main step `n` it sees the results of the tools
  step `n - 2` asked for. The light batch therefore waits for the first step
  whose fork can see a tool result, normally step 2, where the issue the agent
  read with its first tool call is visible.
- After that a heads-up check runs every `check_every_steps` main steps until
  one is found. One fork runs at a time.
- A fork reads the main thread's prompt cache up to the previous request; only
  the newest step's content is billed uncached.
- The daemon closes stdin on `result`, so a fork still running then is dropped.

## Checks

```bash
claude plugin validate server/internal/daemon/ysk/mod
claude plugin test server/internal/daemon/ysk/mod
```

A session that loads the folder (`claude --plugin-dir <folder>`) lays this
build's API declarations in `mod/.claude-plugin/types/` (ignored by Git); then
`tsc -p server/internal/daemon/ysk/mod/.claude-plugin/types` type-checks the
hooks and tests.

The end-to-end run uses a real, authenticated Claude Code and spends quota:

```bash
cd server && MULTICA_RUN_REAL_AGENT_SMOKE=1 go test -tags agentintegration \
  ./internal/daemon -run '^TestYouShouldKnowRealClaudeSmoke$' -count=1 -v
```

`MULTICA_YSK_SMOKE_MODEL` and `MULTICA_YSK_SMOKE_EFFORT` pick the model and
effort.
