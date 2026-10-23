# Step evaluation evidence

`runs.json` reconstructs the mod request material from OL-1011's real Claude
Code 2.1.309 / Sonnet 5.5 executions recorded on OL-1106. `source_run` and
`source_sequences` identify the messages retrievable with
`multica issue run-messages <run-id> --output json`.

- `01a16772-a7e3-762d-8f02-82a92c8ed06d`: platform context before reading code,
  the scheduler Read result, and the completed analysis Write result.
- `01a16774-c142-7c2a-afb6-b142db50e287`: first race report, intervening edits
  (including a failed replacement), and the second race report after the write
  path was changed to `atomic.AddInt64`. The two `.txt` files retain the race
  outputs for the normalization regression.
- `01a16773-ca39-73c5-bc36-58bc119c52c4`: unused import compiler output. The
  command ends with `echo exit=$?`, so the shell succeeded: the reconstructed
  request deliberately has `is_error=false` and empty `error_text`.

Decode the message `output` JSON string once; retain the resulting text, paths,
and line numbers. Input summaries follow the mod's `summarizeInput` field order.
The execution message API does not retain `is_error`; Bash's `Exit code N`
and Edit's `<tool_use_error>` wrappers identify the failing calls here. These
are reconstructed requests, not captured HTTP request bodies. All selected
steps have empty preceding assistant text. The text emitted *after* a decision
is never fed into that decision. Intermediate unselected steps retain their
actual assistant text.

Only the run goals are rewritten, to neutral objectives without a staged
failure plan. Tool material stays unchanged. `StepThinkingFixtures` replays
each run through `buildStepRequest`; no normalized feature or repeat count is
stored in the corpus. Run-level fixtures remain separate and unchanged.
