# Antigravity completion rules

The v0.6.3 integration adopts upstream #8983's completion rules in
`server/pkg/agent/antigravity.go`, as required by OL-927 decision 2.

An unsuccessful structured result can retain a completed answer when all three
conditions hold: the provider error matches the transport-error classifier, the
canonical `result.response` is nonempty, and the latest indexed `agent_response`
step is DONE. The classifier includes EOF, connection/socket/TLS/DNS failures and
the existing network-issue message. Quota, capacity, authentication and other
provider rejections remain failures. Local cancellation and deadlines take
precedence over this recovery.

This replaces OL-910's stricter completion evidence. The adapter no longer
requires a current-turn user-input boundary, equality between step text and the
canonical result, or the absence of later tool/error steps. It no longer checks
OL-910's stream consistency, post-result events or recovery-specific exit-code
and log restrictions. The exact stream-interruption-message exception was also
removed. A structured stream without a terminal result is no longer failed solely
for that omission: a zero exit can complete when the remaining upstream error,
timeout and provider-log checks do not report a failure. These are deliberate
consequences of adopting the upstream rules, not retained OL-910 guarantees.

The fork still retains skill-invocation hooks and usage accounting: completed
step snapshots are deduplicated by index, reported zero differs from missing
usage, cache buckets retain their provider meanings, and resumed runs do not
fall back to conversation-wide aggregate usage. The removed current-turn
boundary filtering is not part of those retained accounting rules.

Regression coverage is in `antigravity_test.go`, including
`TestAntigravityTrailingTransportErrorClassification`,
`TestAntigravityCompletedDespiteTrailingNetworkErrorRequiresAllThree` and the
backend cases for completed, partial and newer partial responses. Run the
Antigravity tests through the fake-CLI guard:

```sh
cd server
../scripts/go-test-with-agent-cli-guard.sh -- go test ./pkg/agent -run TestAntigravity -count=1
```
