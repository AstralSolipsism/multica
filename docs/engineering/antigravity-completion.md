# Antigravity transport-error completion evidence

The adapter can retain a completed response when agy returns one of two known
transport errors in its terminal `ERROR` result. OL-910 extends the older network
error workaround to the exact stream-interruption message, with stricter evidence
for resumed turns. It does not change upstream conversation data or deploy agy.

## Evidence and limits

The [official headless protocol](https://antigravity.google/docs/cli/headless/)
documents indexed `user_input`, `agent_response`, tool and checkpoint updates,
including a single `DONE` response without an earlier `ACTIVE`. The response in
`result` belongs to the current turn; aggregate usage belongs to the conversation.
Step indices can have gaps, so requiring consecutive integers would reject valid
streams. The adapter consumes one print invocation, not multiple stdin prompts.

The OL-910 investigation found one historical interruption record and three later
persisted replies followed by failures carrying that same message. It did not
capture their stdout. Database status `3` and reply timestamps therefore do not
prove that any of those runs emitted `step_update.state=DONE`.

Upstream reports also supply independent observations:

- [CLI issue 1048](https://github.com/google-antigravity/antigravity-cli/issues/1048)
  contains a resumed response reaching DONE while the terminal error repeats a
  historical quota failure. This supports the stale-error hypothesis, but quota
  errors are deliberately **not** allowed by this adapter's workaround.
- [CLI issue 1018](https://github.com/google-antigravity/antigravity-cli/issues/1018)
  reports indexed `error_message` steps on genuine current failures. Their position
  is useful; the adapter does not assume an undocumented error payload shape.

All new fixtures are synthetic, use invented conversation IDs/text/usage, and
exercise the actual backend through a fake executable. They are not raw incident
captures. No real agy invocation, account access, production prompt replay or
production database write is part of this validation.

## Recovery predicate

Recovery requires all of the following:

1. The terminal status is exactly `ERROR` and the error is the existing network
   message or exactly `The stream was interrupted. Please continue the task you
   were working on.` Other provider errors and other terminal states are retained.
2. A completed, indexed `user_input` identifies this invocation's turn. Only the
   old network-error path for a **fresh** conversation may omit this boundary,
   preserving its existing regression fixtures. Resumed runs always require it.
3. The highest-index current response is DONE. Its collected deltas exactly match
   the nonempty canonical result response. A result alone, an old DONE, or a
   partial/newer ACTIVE response is insufficient.
4. No step after that response exists except completed checkpoints. Thus a later
   error (even DONE), tool (even DONE), unknown step or ACTIVE checkpoint prevents
   recovery. Earlier error steps may have been recovered by the completed reply.
   For the new interruption case all current steps must be DONE. The old network
   case retains the existing earlier-ACTIVE-tool exception for background commands
   cancelled by a separate tool step, followed by a final response.
5. There are no ambiguous indices, conflicting kinds, regressing states,
   conflicting terminal deltas, conversation changes, extra turn boundaries,
   malformed stream lines, scanner failures, or events after the terminal result.
6. Local cancellation/deadlines and agy's logged print timeout take precedence.
   A current provider-error log prevents recovery. Only normal exits 0 and the
   provider-error exits 1/3 are eligible; signals and other exit codes are not.

This interprets a known interruption as recovered only after a later complete
current reply with no subsequent error/work evidence. It relies on agy emitting
the active turn's step transitions, as its protocol specifies. It is not a claim
that the adapter has a unique identifier for the error's original occurrence.

If a version omits the turn boundary/completion evidence, rewrites the final
response, emits multiple boundaries, or supplies contradictory events, keep the
failure. The minimal additional evidence for such cases is a sanitized stream
including init, current user-input index, response deltas/states, all later steps,
terminal result, process exit code and relevant timeout/provider diagnostics.
For a protocol that can silently omit error steps, upstream must expose a
turn-scoped terminal outcome or an error's originating turn/step index; comparing
message text cannot distinguish two occurrences of the same error. Do not extend
the workaround based only on a SQLite status or a matching error string.

## Output, usage and ordering

On resume, pre-boundary snapshots are held until ownership is known; snapshots
older than the boundary never emit text/tools or enter the usage sum. If a
resumed legacy stream has no boundary at all, its existing output/usage behavior
is retained, but it cannot use either recovery exception. A response arriving
before its boundary is ambiguous and does not prove completion.

Identical repeated DONE text is emitted once; repeated DONE usage replaces the
same index's snapshot. Earlier-index steps arriving after later ones cannot
replace the latest response. An ACTIVE after DONE on the same index fails closed
because there is no event sequence number to resolve it. Historical snapshots
below the boundary are ignored regardless of arrival order.

The canonical result response and conversation ID still drive the final result.
Usage sums current completed steps once, including reported zero; a resumed
conversation never falls back to the historical aggregate. Numeric gaps are
accepted because not every internal step is necessarily emitted.

## Verification

From `server/`:

```sh
bash ../scripts/go-test-with-agent-cli-guard.sh -- go test ./pkg/agent -run 'TestAntigravity' -count=1
bash ../scripts/go-test-with-agent-cli-guard.sh -- go test -race -parallel 2 ./pkg/agent -run 'TestAntigravity|Test.*Usage' -count=1
```

From the repository root:

```sh
bash scripts/test-go.sh --race --only agent
git diff --check
```

`TestAntigravityBackendCompletionEvidence` covers recovered historical and
same-turn interruptions, old network errors, replayed history, duplicated DONE
text/usage, ordered completion, and the failure boundaries above.
`TestAntigravityBackendCompletionHonorsContext` verifies local cancellation and
timeout even after a complete reply and matching error result. Existing
Antigravity tool, usage, model, transcript and legacy-network tests remain in the
same package suite. A structured stream ending without a terminal result fails
even when the process exits zero.
