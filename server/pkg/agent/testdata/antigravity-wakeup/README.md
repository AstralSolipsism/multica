These are complete `agy 1.5.12 -p --output-format stream-json --print-timeout 150s`
stdout captures from 2026-11-19. Conversation IDs and absolute paths are redacted;
event ordering, deltas, tool lifecycles, usage and result fields are unchanged.

The command printed a start marker, slept for 25 seconds, then printed a completion
marker. `WaitMsBeforeAsync=10000` appears in the recorded model tool arguments;
agy omits it from stdout's tool metadata. The model yielded with `OL1462_WAITING`
and replied `OL1462_FINAL` after the task completion notification.

- `native.jsonl`: Gemini 3.8 Flash (Low), exit 0, 42.123 seconds total. No polling.
- `schedule.jsonl`: same model, exit 0, 45.715 seconds. An additional 60-second
  timer used the command's task ID as `TimerCondition` and was cancelled early
  when the command completed. The completion notification woke the model.
- `timeout.jsonl`: Gemini 4 Neon (High), exit 3, 159.808 seconds including startup
  and cleanup. The command completed, but the subsequent model response did not
  finish before the 150-second print deadline.

`run_command` stays ACTIVE until the command actually exits, even though the
model receives its background task ID after ten seconds. Later stdout steps may
be delivered together after that tool completes. A wakeup is a `system_message`,
not a new `user_input`. Successful `result.response` includes both the waiting
reply and final reply. Tests replay these captures offline without delays or
access to a real CLI or account.
