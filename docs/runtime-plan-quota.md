# Runtime subscription quota observations

Subscription quota is the provider account's allowance, not task token usage or
an estimate of money remaining. Runtimes sharing an account share its limits.

## Heartbeat contract and freshness

The server and daemon share `protocol.ValidateRuntimePlanQuota`. A window needs
a name (up to 32 bytes) or a nonblank group (up to 32 bytes). This accepts the
unnamed grouped snapshots sent by deployed Antigravity daemons over both HTTP
and WebSocket heartbeats. New Antigravity snapshots set both name and group to
the pool ID so older servers also accept them.

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
ownership checks reject unaccepted sockets (`inode=0`). When the daemon runs
as root (`euid=0`), Kimi collection and credential delivery are disabled, with
one startup warning. Kimi 0.40 responses use the union of `data.summary` and
`data.limits`; Kimi 2.1.1 responses use `data.quota.usages.limit5h` and
`limit7d`, converting `usedRatio` to a percentage and `resetAt` to Unix seconds.
The response structure selects the parser, without invoking the CLI.

An explicit zero is a valid observation. Missing, unknown or invalid new-format
usage rows do not manufacture unused quota. The weekly row retains its identity
when the five-hour row is absent. Quota responses take precedence when both
response formats are present; wallet balances never enter the snapshot.

## Antigravity

The daemon polls `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
with the exact JSON body `{}` and `User-Agent: antigravity-cli/<detected version>`.
This is an internal Google API, verified with agy 1.2.16 in OL-108; future CLI
upgrades need a live check. The snapshot contains one row per known pool:

- Gemini: minimum `remainingFraction` across `gemini-*` models.
- Claude + GPT: minimum across `claude-*` and `gpt-*` models.

Each pool uses the earliest valid `resetTime` among its usable buckets. Without
a valid reset, both the reset timestamp and window duration remain absent.
The current [retrieveUserQuota bucket contract](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/code_assist/types.ts#L255-L265)
has no explicit window kind or duration (`tokenType` identifies the metered
resource). Until that metadata is available, a positive reset within six hours
of `observed_at` is labeled 5h
(300 minutes); a later reset is labeled weekly (10080 minutes). This heuristic
can misclassify a weekly window in its final six hours, or quotas with other
periods. Reset timestamps are preserved even when no duration can be inferred.

Fractions are converted to used percentages; an exhausted model marks the
snapshot limited. Missing/invalid fractions and unknown model families are
omitted. A response without usable buckets fails collection and preserves the
last successful observation.

The access token is read on every round from
`~/.gemini/antigravity-cli/antigravity-oauth-token`: its `token` object contains
an `access_token` string (`{"token":{"access_token":"…"}}`). agy owns token
refresh; keep the existing `agy remote-control` watchdog active and signed in. The collector does
not start tasks, refresh credentials or probe local RPC listeners. It sends the
token only to Google's endpoint and refuses redirects. Neither token nor account
metadata appears in heartbeat payloads or diagnostics.

One account request feeds all registered local Antigravity runtimes every two
minutes (with startup jitter), including idle machines. HTTP 429 backs off up to
30 minutes. Failures keep the actual last observation time. `/health` reports
`oauth_token_unavailable`, `authorization_rejected`, `rate_limited`,
`collection_failed`, `not_registered` or `no_version`; success clears the reason.

After deploying the daemon build, verify the Kimi cards on main and agent-2 and
the Antigravity card on GCP show an `observed_at` less than five minutes old during
normal successful polling. Collector smoke tests below verify data acquisition
only; UI acceptance also requires the updated daemon's heartbeat to reach the
server. Rolling back the daemon build restores the prior collectors and their
known incompatibility with these CLI versions; no data migration is involved.

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
