# labrastro-ysk

The Claude Code mod and OMP extension behind "You should know" (OL-187): short tips for the
people watching an agent work. The interface contract is OL-187 section 13.

## Flow

1. The server adds `you_should_know` to a claim when the workspace has the
   feature on and the daemon advertises `you-should-know-v1` (13 A, B).
2. For a Claude task on Claude Code 2.1.287 or later, the daemon
   (`../labrastro_ysk.go`) writes this mod to `<task config>/ysk/plugin/`, the
   claim field as received to `<task config>/ysk/context.json`, and sets
   `CLAUDE_CODE_PLUGIN_DIRS` and `MULTICA_YSK_CONTEXT_FILE` (13 C). Otherwise
   it writes and sets nothing for Claude. For OMP the daemon writes the same
   modules and context, and `piBackend` passes `hooks/omp.ts` via `--extension`.
   The extension uses `ctx.runEphemeralTurn({ promptText, tools: false })` and
   emits private `labrastro_ysk` JSONL frames; `piBackend` consumes them before
   transcript handling and forwards batches through `OnYouShouldKnow`.
   No side-turn message is appended to OMP history or task chat.
3. The adapters read context at `session.start` / `session_start` and remove
   their environment variables, so nested CLIs do not inherit them. Claude
   filters `agentId`; OMP filters `ctx.agent.kind === "main"`, including clones
   and Advisor tool calls. OMP side-turn failures are silent, with a 30-second
   abort signal and cancellation at `session_shutdown`.
4. On main-thread `turn.step`s it asks `$.model.fork` (never awaited) and logs
   each batch with `$.ui.log` (13 D). `pkg/agent/labrastro_ysk.go` takes those
   `ui_log` lines out of the stream and the daemon posts them to
   `POST /api/daemon/tasks/{taskId}/tips` (13 E). Failures are only logged.
5. Status polls carry the current `you_should_know_enabled` workspace setting
   (13 K). Once it is explicitly false, the daemon writes `<task config>/ysk/stop`.
   Before each scheduled fork the mod reads that marker; a successful read
   stops new forks for the rest of the session, while existing forks may finish.
   Missing/unreadable markers leave generation enabled. Re-enabling the
   workspace only affects later runs.

## Timing

Both runtimes share `schedule.ts`, `prompts.ts` and `reply.ts`:

- The opening light batch waits for three substantive exploration rounds
  (source reads/searches, git diff/history or diagnostics). Multiple tools in
  one round count once. Platform metadata and checkout commands do not count.
  Claude forks see tool results one request behind the main thread, so both
  adapters wait two steps after the third round. With two initial metadata
  rounds, light runs at zero-based step 6 (the seventh main step).
- The eighth main step is the fallback for discussion/planning tasks. The
  prompt permits empty tips, requires concrete evidence, and focuses on root
  causes, module relationships, substantive changes and owner caveats. It
  forbids assignment restatements, activity logs and generic advice.
- After that heads-up checks back off geometrically (OL-1270): the first
  check keeps `check_every_steps`, then the gap doubles each round up to 4x,
  until a heads-up is found. A new fork starts only when the previous one has
  answered or has been open for 30 main steps; once a newer fork has started,
  the older one's answer is ignored, so a run sends one heads-up at most.
- Tips the run has sent join the issue's tips and the person's known topics:
  later questions list them, and an answer repeating any of them (ignoring
  width, case and whitespace) is dropped.
- A fork reads the main thread's prompt cache up to the previous request; only
  the newest step's content is billed uncached.
- The daemon closes stdin on `result`, so a fork still running then is dropped.

## OMP Advisor

The daemon carries the effective `--advisor` launch flag (including managed
`runtime_config.advisor_enabled`) into the extension. Advisor-enabled runs
keep the one light request but disable periodic heads-up requests. Delivered
`message_end` custom messages with `customType: "advisor"` and `details.notes`
feed the bridge; the advisor's private `advise` tool calls are not consumed.
Seeing such a message also disables further polling if Advisor was enabled
inside the session.

A `nit` (also the OMP default for an omitted severity) becomes `you_should_know`;
`concern` and `blocker` become `heads_up`. Whitespace is normalized, the first
sentence supplies the line/title, and fields are clipped by Unicode code point
at the claim's limits. The bridge and model replies share deduplication against
existing tips, known topics and emitted tips, and the three-light/one-heads-up
per-task quota. An early Advisor note can consume a light slot; the opening
request still checks for overturned tips. No extra model formats the notes.

The OMP contracts are defined in upstream
[extension types](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/extensions/types.ts),
[side turns](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts)
and [Advisor messages](https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/chat/messages.ts).

## Checks

```bash
claude plugin validate server/internal/daemon/ysk/mod
claude plugin test server/internal/daemon/ysk/mod
pnpm test:ysk
```

A session that loads the folder (`claude --plugin-dir <folder>`) lays this
build's API declarations in `mod/.claude-plugin/types/` (ignored by Git); then
`tsc -p server/internal/daemon/ysk/mod/.claude-plugin/types` type-checks the
hooks and tests.

`pnpm test:ysk` exercises the OMP adapter with mocked host events and no model
requests. Go tests cover installation, provider gates, stream interception,
stop lifetime and Tip Chat for both providers. The shared quality CI action
runs the extension suite when files in this directory change.

The end-to-end run uses a real, authenticated Claude Code and spends quota:

```bash
cd server && MULTICA_RUN_REAL_AGENT_SMOKE=1 go test -tags agentintegration \
  ./internal/daemon -run '^TestYouShouldKnowRealClaudeSmoke$' -count=1 -v
```

`MULTICA_YSK_SMOKE_MODEL` and `MULTICA_YSK_SMOKE_EFFORT` pick the model and
effort.
