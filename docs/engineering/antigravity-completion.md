# Antigravity completion rules

agy's terminal `result` describes the conversation, not the invocation that
produced it. After a resumed turn has answered, the result can still repeat an
error that an earlier turn recorded. OL-910 saw this with a stream-interruption
message, and OL-1074 with a stream idle timeout repeated by every later turn.
[CLI issue 1048](https://github.com/google-antigravity/antigravity-cli/issues/1048)
shows the same with a historical quota error. Allowing one more error wording at
a time could not keep up, so since OL-1074 an `ERROR` result is judged by the
invocation's own steps. This replaces OL-910's wording allowlist. It also
replaces the upstream #8983 transport classifier that the v0.6.3 integration
adopted under OL-927 decision 2; that classifier now serves only the legacy
streams described below.

The rules are in `server/pkg/agent/antigravity_completion.go`.

## Decision table

`decideAntigravityOutcome` applies these rows in order. The first match wins.

| Row | Condition | Status | Error |
| --- | --- | --- | --- |
| 1 | The daemon's deadline elapsed | `timeout` | `agy timed out after …` |
| 2 | The run was cancelled | `aborted` | `execution cancelled` |
| 3 | `ERROR` result, recovery gate open, turn evidence proves the answer | `completed` | none; a warning keeps the original error |
| 4 | Legacy: `ERROR` result, recovery gate open, fresh stream without a boundary, settled answer, transport-error wording | `completed` | none; a warning keeps the original error |
| 5 | Any other non-success result | the mapped result status | `result.error`, or `agy returned status …` |
| 6 | Non-zero exit | `failed` | `agy exited with error: …` |
| 7 | agy's print timeout in its log | `timeout` | `agy --print-timeout elapsed …` |
| 8 | Provider error in its log | `failed` | `agy provider error: …` |
| 9 | Otherwise, including a clean exit without a result | `completed` | none |

Only the `ERROR` status (ignoring case and surrounding whitespace) is
replaceable. Cancelled, timed-out, interrupted and unknown statuses stay in
row 5. The recovery gate requires exit 0, or one of the codes 1 and 3 that agy
uses for provider errors, and neither a print timeout nor a provider error in
the log. A signal or another exit code therefore keeps agy's structured error.
That error still precedes the exit, print-timeout and provider-log diagnostics.
Rows 1, 2 and 5–9 keep their earlier semantics, including completion after a
zero exit without a result event. After the table, an empty completed output is
still recovered from agy's transcript.

The recovery warning is
`agy reported an error after this turn's answer completed`, with the original
`err` and the `evidence` row (`current turn` or `legacy transport error`).

## Turn evidence (row 3)

A completed `user_input` step marks where the invocation's turn begins. The
error's wording plays no part. The evidence requires all of the following:

1. The boundary exists and is `DONE`. A resumed run without a boundary has no
   evidence.
2. The highest-index `agent_response` after the boundary is `DONE`, and its
   deltas equal the nonempty `result.response`. One terminal LF on either side
   is ignored, as PR 8983's capture shows agy appending one; no other difference
   is.
3. Only `DONE` checkpoints follow that response. A later error, tool, unknown
   step or `ACTIVE` checkpoint belongs to this turn and was never answered.
4. When an `error_message` step precedes the response, no response text lies
   between the boundary and the last such error. The final response could
   otherwise continue an interrupted one, and the protocol does not tell
   narration from a partial answer. Earlier unfinished steps are allowed,
   because agy leaves a background command `ACTIVE` when a separate step
   cancels it.
5. The stream is consistent. It has no malformed or plain lines, scanner
   errors, unknown events or null payloads. No step lacks an index or has a
   negative one, has a state other than `ACTIVE`/`DONE` or changes kind, and no
   `DONE` step regresses or changes its delta. There is one boundary, the
   conversation ID matches the resumed one throughout, and nothing follows the
   result.

## Legacy streams (row 4)

Streams from agy releases without `user_input` steps cannot show where a turn
began. For a fresh conversation, which has no history to replay, the adapter
keeps the transport-error wordings it accepted before OL-1074. These are the
network-issue sentence and the Go transport causes of upstream #8983
(`antigravityTransportErrorRe`). The answer must meet conditions 2–5, with the
whole stream as the turn. This compatibility path is the only wording-based
rule, and no wording may be added to it. A resumed stream without a boundary
never recovers.

## Output and usage

On a resumed conversation, snapshots that arrive before the boundary are held
until it does. Those below its index are history and never reach the
transcript, tool events or usage. A held snapshot at or above the boundary
arrived out of order. It invalidates the evidence but is released after the
boundary, so this turn's output survives. When no boundary arrives at all, the
held snapshots are released at the result: their output survives, but cannot
prove completion. Repeated `DONE` text is emitted once, and repeated `DONE`
usage replaces that step's snapshot.

`result.response` and the conversation ID still drive the final result. Usage
sums this turn's completed steps, including a reported zero. A resumed run never
falls back to the conversation-wide aggregate.

## Assumptions and evidence

The [headless protocol](https://antigravity.google/docs/cli/headless/)
documents indexed `user_input`, `agent_response`, tool and checkpoint updates,
including a single `DONE` response without an earlier `ACTIVE`. No raw stdout
of the OL-910 or OL-1074 runs was retained. Their step facts come from
read-only views of agy's conversation store.

Message timing supports the boundary assumption. The v0.6.1-labrastro.6 adapter
holds a resumed run's steps until the boundary arrives. Even so, the tool events
of a 53-minute resumed agy 1.4.5 run in OL-1074 arrived live throughout, so the
boundary preceded that turn's steps.

The rules also assume that the final answer ends `DONE` and equals
`result.response`. A release that stops emitting the boundary, or changes how
the answer relates to the result, makes runs keep agy's failure rather than
complete. An error that a release reports without any step is not visible to
these rules. OL-1075 (deferred) tracks verifying the assumptions against new
agy releases.

## Tests

`antigravity_completion_test.go` drives the backend with synthetic streams from
a fake agy executable. None is a captured stream, and no test runs a real agy or
reads production data. It covers:

- each table row (`TestDecideAntigravityOutcome`);
- completion despite five stale wordings
  (`TestAntigravityTurnEvidenceOverridesStaleError`);
- every counterexample above, under both a new wording and a legacy one;
- context precedence, legacy streams and output scoping.

The upstream classifier and backend cases in `antigravity_test.go` remain.

```sh
cd server
../scripts/go-test-with-agent-cli-guard.sh -- go test ./pkg/agent -run 'Antigravity' -count=1
```
