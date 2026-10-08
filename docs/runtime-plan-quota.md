# Runtime subscription quota observations

Subscription quota is the provider account's allowance, not task token usage or
an estimate of money remaining. Runtimes sharing an account share its limits.

## Heartbeat contract and freshness

The server and daemon share `protocol.ValidateRuntimePlanQuota`. A window needs
a name (up to 32 bytes) or a nonblank group (up to 32 bytes). This accepts the
unnamed grouped snapshots sent by already-deployed Antigravity daemons over
both HTTP and WebSocket heartbeats. New Antigravity snapshots name each window
`<pool>_5h` / `<pool>_weekly` and set group to the pool ID; the non-empty name
keeps older servers accepting them.

Invalid heartbeat snapshots leave the last stored quota untouched. Every drop
increments `multica_runtime_plan_quota_dropped_total{provider}`; warnings include
runtime ID, provider and validation error, capped at one per runtime every five
minutes per server process. External quota pushes still return HTTP 400 on
invalid input. Conditional database writes and the five-minute freshness throttle
are unchanged.

The UI marks Kimi, Antigravity and ZenMux observations stale after one hour,
longer than the collectors' maximum 30-minute rate-limit backoff. Codex, Claude
and other providers retain the 24-hour threshold. A window whose reset has
passed stays visible as "Reset, awaiting refresh" without its old percentage.
Machine chips show waiting or stale states instead of disappearing; their
tooltips retain every reported window. No new quota is inferred from a reset.

A machine chip shows "Reset, awaiting refresh" when any window has reset: the
remaining quota in that window is unknown, so the chip cannot summarize the
account's usable allowance. Other windows' current percentages remain visible
in the tooltip and detail views until the snapshot becomes stale. For Codex and
Claude, which report quota with tasks, a five-hour reset therefore also hides
the weekly percentage from the machine chip until the next task reports quota.
Without a new task this can last for hours; once the observation is more than
24 hours old, the chip and its tooltip show "Stale data" instead.

## Claude Code

The Claude adapter consumes `rate_limit_event` from the existing non-interactive
stream-json execution. It makes no quota API request and starts no idle poller.

- The documented `rate_limit_info` fields describe the limiting window.
- Claude Code 2.1.286 also emits `unifiedWindows`: five-hour, weekly and, when
  reported, model-specific weekly observations from response headers.
- Utilization is a fraction; multiply by 100 for `used_percent`. Zero is a real
  observation, missing is unknown, and legitimate values above 100 are retained.
- `resetsAt` is Unix seconds. Do not infer a refreshed allowance when a reset
  passes. Keep the window visible while waiting for another observation.
- `allowed_warning` is not a rejection. Only `rejected` marks the snapshot limited.
- Unknown windows, malformed observations and pay-as-you-go overage balances do
  not produce invented subscription percentages or overwrite the last valid data.

Live observations update the existing daemon quota cache through
`ExecOptions.OnPlanQuota`, then travel through normal heartbeats and telemetry.
The final result also retains the latest snapshot, including failed executions.
Older concurrent task results cannot replace a newer cached observation.
Quota events do not become task transcript messages or watchdog progress.

No task means no fresh Claude observation. Keep the actual observation timestamp;
the existing stale and reset rules apply. A runtime's displayed allowance belongs
to its logged-in account; do not sum allowances across runtimes.

`unifiedWindows` is an internal CLI extension. When upgrading Claude Code, verify
its actual stream fields against `claude_plan_quota_test.go`, including missing
windows and reset timestamps. A successful synthetic parser test does not prove
the current account emitted a sample.

## Kimi Code

The daemon polls the local `kimi web` Server API every two minutes. It requires
a same-user connection peer before sending the local `server.token`; Linux
ownership checks reject unaccepted sockets (`inode=0`), even though those rows
report `uid=0`. Root daemons collect by default under the same rule: the accepted
peer must also belong to root. This preserves the local user account boundary;
another root process can already read the `0600` token file. Unsupported
platforms still disable collection when peer ownership cannot be proven.

Kimi 0.40 responses use the union of `data.summary` and
`data.limits`; Kimi 2.1.1 responses use `data.quota.usages.limit5h` and
`limit7d`, converting `usedRatio` to a percentage and `resetAt` to Unix seconds.
The response structure selects the parser, without invoking the CLI.

An explicit zero is a valid observation. Missing, unknown or invalid new-format
usage rows do not manufacture unused quota. The weekly row retains its identity
when the five-hour row is absent. Quota responses take precedence when both
response formats are present; wallet balances never enter the snapshot.

## Antigravity

The daemon polls `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
with the exact JSON body `{}` (no project id required) and
`User-Agent: antigravity-cli/<detected version>`. This is the internal Google
API the Antigravity client's own usage page reads; it was verified live
against agy 1.3.0 in OL-141 on both `cloudcode-pa` and `daily-cloudcode-pa`
(identical answers, so the daemon keeps `cloudcode-pa`). The response lists
quota pools under `groups[]`, one bucket per pool and window:

| Response field | Maps to |
|---|---|
| `groups[].buckets[].bucketId` — `gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly` | `Group`: `gemini-*` → `gemini`, `3p-*` → `claude_gpt`; `Name`: `<group>_5h` / `<group>_weekly`; other pools are skipped |
| `groups[].buckets[].window` — `"5h"` or `"weekly"` | `WindowMinutes`: 300 / 10080; unrecognized or missing values keep the window without a duration and name it by the raw `bucketId` — never inferred |
| `groups[].buckets[].remainingFraction` | `UsedPercent = (1 - fraction) × 100`, two decimals |
| `groups[].buckets[].resetTime` — RFC3339, fractional seconds tolerated | `ResetsAt`; dropped when the fraction is 1.0 |

Every recognized bucket maps to exactly one window: no aggregation across
buckets and no period inference (the pre-OL-141 six-hour-distance heuristic is
gone). A fully replenished window (fraction 1.0) reports a rolling `resetTime`
of "now + period" that advances on every collection, so its reset timestamp is
dropped — the UI shows no countdown and never an awaiting-refresh state for it.
A bucket with fraction 0 marks the snapshot limited. A bucket the API flags
`disabled` (the 5-hour limit does not apply while the weekly pool is
exhausted) passes through verbatim: full fraction, no reset, unchanged period.

Malformed JSON, a known-pool bucket without a valid fraction, duplicate
windows, a result that fails the shared wire contract (e.g. an oversized
window name), or a response without any known pool fails the whole round
(fail-closed): the platform keeps the last successful observation and
`/health` shows `collection_failed`. A missing or unparsable `resetTime` on
an otherwise valid bucket is tolerated — the window simply carries no
countdown. The legacy per-model `retrieveUserQuota` endpoint is no longer
queried and is never used as a fallback.

The access token is read on every round from
`~/.gemini/antigravity-cli/antigravity-oauth-token`: its `token` object contains
an `access_token` string (`{"token":{"access_token":"…"}}`); the location was
reverified unchanged on agy 1.3.0. agy owns token refresh; keep the existing
`agy remote-control` watchdog active and signed in. The collector does not
start tasks, refresh credentials or probe local RPC listeners. It sends the
token only to Google's endpoint and refuses redirects. Neither token nor
account metadata appears in heartbeat payloads or diagnostics.

One account request feeds all registered local Antigravity runtimes every two
minutes (with startup jitter), including idle machines. HTTP 429 backs off up to
30 minutes. Failures keep the actual last observation time. `/health` reports
`oauth_token_unavailable`, `authorization_rejected`, `rate_limited`,
`collection_failed`, `not_registered` or `no_version`; success clears the
reason.

This is an internal Google API; future CLI upgrades need a live check — the
capture test below exercises the same endpoints against the signed-in account.
After deploying the daemon build, verify the Kimi cards on main and agent-2
and the Antigravity card on GCP show an `observed_at` less than five minutes
old during normal successful polling; that check is OL-141 acceptance 7 and
completes OL-113's deployment acceptance. Collector smoke tests below verify
data acquisition only; UI acceptance also requires the updated daemon's
heartbeat to reach the server. Rolling back the daemon build restores the
per-model endpoint and the six-hour inference; no data migration is involved.

## Zhipu / GLM

The backend's existing GLM account collector and API are unchanged. Web and Desktop
show its card once above the runtime list, including an empty list. Its display
does not depend on `anchor_device` or a runtime's provider/login. Unconfigured or
never-successful collection remains absent rather than showing a zero balance.

## Focused verification

- `go test ./pkg/agent -run TestClaude -count=1`
- `go test ./internal/daemon -run 'Test.*(PlanQuota|Quota|RuntimeIDsForProvider)' -count=1`
- Shared runtime quota component tests and `packages/core/runtimes/plan-quota.test.ts`.
- Check the actual runtime CLI, build seed, Web/Desktop and update-channel identities
  on deployment. Let a normal Claude task supply the first account observation.

On an authorized provider host, run these read-only quota smoke tests from
`server/` (they access the signed-in account but do not start an agent task):

```sh
MULTICA_RUN_REAL_AGENT_SMOKE=1 go test -tags=agentintegration ./internal/daemon -run '^TestKimiPlanQuotaLive$' -count=1 -v
MULTICA_RUN_REAL_AGENT_SMOKE=1 go test -tags=agentintegration ./internal/daemon -run '^TestAntigravityPlanQuotaLive$' -count=1 -v
```
