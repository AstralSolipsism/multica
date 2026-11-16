# Runtime and global quota observations

Runtime subscription quota is the provider account's allowance, not task token
usage. Runtimes sharing an account share its limits; the UI never sums their
allowances. Global `quota_source` snapshots are separate: they can additionally
represent real currency balances and free-channel health, as described below.

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

## Machine → Runtime → provider hierarchy

The three surfaces keep the same mental model; there is no cross-machine or
cross-Runtime deduplication.

- **L1 — machine rows.** `runtime-machines.ts` emits exactly one quota chip per
  Runtime. `machine-quota-chips.tsx` renders a bordered Runtime capsule with
  its icon/name on the left and its provider or model pools on the right.
  Single-provider CLIs show one summary; Antigravity shows Gemini and Claude +
  GPT; OMP shows its serving provider pools. Like single-provider and
  Antigravity summaries, each OMP pool's percentage and mini meter use the
  aggregate window with the least remaining percentage, never a hard-coded
  window duration. A Runtime never splits into pool-level chips. The first
  eight Runtime capsules wrap naturally and any remainder appears as Runtime
  capsules in the `+N` hover card.
- **Shared hover — one Runtime, one card.** Hovering an L1 capsule or the L2
  quota cell opens one `QuotaHoverCard` for the whole Runtime. Its header is
  `Runtime · machine`, with collection source and freshness on the right.
  Single-provider windows appear directly; Antigravity and OMP use labeled
  pool sections. Every OMP section includes available/total accounts, aggregate
  windows and at most four account rows, with the remainder deferred to L3.
- **L2 — machine details.** Each table row is already a Runtime. Its quota cell
  lists provider/model-pool summaries on separate lines and has one hover
  trigger for the same whole-Runtime card as L1.
- **L3 — Runtime details.** `RuntimeQuotaCard` uses labeled provider/model-pool
  sections, a two-column window grid and full account tables. Serving OMP pools
  are visible by default; idle pools are behind an accessible disclosure.
  Antigravity's Gemini and Claude + GPT pools remain separate sections within
  the one Runtime card.

`partitionAccountPools` is the only serving-pool filter. No matching active
provider prefix (including no agents, a default/unrecognized model, or only
archived agents) falls back to all reported pools instead of rendering an empty
surface. The fallback is not evidence of usage: L3 only marks pools unused when
the agent query is settled and a real provider intersection or an agent-less
Runtime establishes that state.

## Display rules

The Runtime list cell, Runtime settings card, machine capsules and global
subscription cards apply one set of rules (`evaluatePlanQuota` in
`packages/core/runtimes/plan-quota.ts`):

- **Reset and recovery times are always absolute.** Every Runtime hover row,
  L3 normal/exhausted window, OMP earliest account recovery and global
  subscription tooltip goes through `formatQuotaTime` or
  `useQuotaTimeFormatter` in `packages/views/runtimes/components/quota-time.ts`
  (usually via `quotaWindowResetText`, `quotaStatusText` or
  `accountPoolRecoveryText`). The viewer's Preferences timezone wins, with the
  browser timezone as fallback. Same-day values show `HH:mm`; other days add
  month and day (for example `11月15日 10:20` in Chinese), with locale-appropriate
  “reset”, “recover” and “earliest recovery … (#account)” wording. There are no
  future-reset countdown branches or locale countdown keys. Elapsed collection
  freshness such as “updated 2m ago” is intentionally different and remains a
  compact past duration.
- **A passed reset refills its window.** The window counts as 100% with no next
  reset, and its row notes when it was refilled. The next observation replaces
  the inference.
- **Pools.** Windows sharing a `group` form a pool; ungrouped windows form one
  pool. A used-up window limits its pool until the latest reset among the
  pool's used-up windows. Used up means at least 100% used; a `limited`
  snapshot without such a window counts its windows without a percentage as
  used up. While a pool is limited, every window that resets by the recovery,
  or reports no reset, is "Not applicable now", used up or not; only the
  used-up windows the recovery waits for keep their value. An unlimited pool
  is bound by its least remaining window, the later reset winning a tie (an
  unknown reset counts as later). Colors follow each pool and window, never
  the snapshot status alone.
- **A limit that names no window.** A `limited` snapshot whose windows all
  carry a percentage below 100% is "Rate limited" as a whole. No window or pool
  is guessed: there is no recovery time, independent pools are not split, and
  no reset lifts the limit before the next observation replaces the snapshot.
  Each window keeps its own balance and color.
- **Independent pools stay nested.** Antigravity's model groups retain their
  own balances and colors, while Claude's model-specific pools still constrain
  the Runtime as a whole. This distinction controls summaries inside the one
  Runtime capsule/card; it never creates another machine-level quota subject.
- **Freshness.** Task-reported providers (Codex, Claude and others) never age
  out: no task means no usage, so the last balance holds until its reset.
  Collectors (Kimi, OMP, Antigravity and ZenMux) and the server's global
  quota-source pollers show "Collection interrupted" after an hour without a
  successful poll, longer than the collectors' 30-minute maximum backoff. The
  last balance stays visible, uncolored, with the absolute time of the last
  update.
- Runtimes sharing one account are not detected and no account information is
  read; each runtime shows its own observations.

## Claude Code

The Claude adapter consumes `rate_limit_event` from the existing non-interactive
stream-json execution. It makes no quota API request and starts no idle poller.

- The documented `rate_limit_info` fields describe the limiting window.
- Claude Code 2.1.286 also emits `unifiedWindows`: five-hour, weekly and, when
  reported, model-specific weekly observations from response headers.
- Utilization is a fraction; multiply by 100 for `used_percent`. Zero is a real
  observation, missing is unknown, and legitimate values above 100 are retained.
- `resetsAt` is Unix seconds. The daemon reports only what it observed; the UI
  refills a window whose reset has passed (see Display rules).
- `allowed_warning` is not a rejection. Only `rejected` marks the snapshot limited.
- Unknown windows, malformed observations and pay-as-you-go overage balances do
  not produce invented subscription percentages or overwrite the last valid data.

Live observations update the existing daemon quota cache through
`ExecOptions.OnPlanQuota`, then travel through normal heartbeats and telemetry.
The final result also retains the latest snapshot, including failed executions.
Older concurrent task results cannot replace a newer cached observation.
Quota events do not become task transcript messages or watchdog progress.

No task means no fresh Claude observation and no usage from this runtime. Keep
the actual observation timestamp; the display rules apply. A runtime's displayed
allowance belongs to its logged-in account; do not sum allowances across runtimes.

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

The daemon polls `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
with the exact JSON body `{}` (no project id required) and
`User-Agent: antigravity/cli/<detected version>`. The version is extracted from
CLI discovery rather than pinned. Both the host and the native CLI identity
are required: the agy 1.4.2 investigation in OL-846 found that `cloudcode-pa`
returned HTTP 200 with a different, stagnant Gemini quota view, while
`daily-cloudcode-pa` with the former `antigravity-cli/` identity omitted Gemini.
Only the corrected pair matched the client's percentages and reset times.
The response lists quota pools under `groups[]`, one bucket per pool and window:

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
dropped and the UI shows no reset time for it. A bucket with fraction 0 marks
the snapshot limited. A bucket the API flags `disabled` (the 5-hour limit does
not apply while the weekly pool is exhausted) passes through verbatim: full
fraction, no reset, unchanged period. The UI shows it as not applicable while
its pool's weekly window is used up.

Malformed JSON, a known-pool bucket without a valid fraction, duplicate
windows, a result that fails the shared wire contract (e.g. an oversized
window name), or a response without any known pool fails the whole round
(fail-closed): the platform keeps the last successful observation and
`/health` shows `collection_failed`. A missing or unparsable `resetTime` on
an otherwise valid bucket is tolerated — the window simply carries no
reset time. Neither the `cloudcode-pa` host nor the legacy per-model
`retrieveUserQuota` endpoint is used as a fallback: a successful HTTP response
from another quota view does not establish that its data is current.

The access token is read on every round from
`~/.gemini/antigravity-cli/antigravity-oauth-token`: its `token` object contains
an `access_token` string (`{"token":{"access_token":"…"}}`); the location was
reverified unchanged on agy 1.4.2. agy owns token refresh; keep the existing
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
After deploying the daemon build, compare the Antigravity card's remaining
percentages and reset times with the client for the same account and windows.
Observe updates during normal task usage, allowing for the two-minute poll
interval and display rounding. An `observed_at` less than five minutes old
confirms recent collection, not the accuracy of the selected quota view.
Collector smoke tests verify data acquisition only; UI acceptance also requires
the updated daemon's heartbeat to reach the server. Offline fixtures do not
replace that deployment check. Reverting OL-846 restores the known incorrect
host/identity pair; no data migration is involved.

## Global quota and service-status sources

The cards above the machine list come only from workspace-visible `quota_source`
records, not from a Runtime heartbeat. `QuotaSourceSnapshot` keeps these global
observations separate from `agent_runtime.plan_quota`. Credentials remain in the
server's secretbox and API responses expose only their masked hint; snapshots
contain measurements, never API keys. Private/shared visibility and the outbound
host allow-list/SSRF checks apply to every source kind.

There are three display contracts:

1. **Subscription windows — `glm`, `zenmux`.** The snapshot uses the same
  `windows` shape as Runtime plan quota. Cards show localized window labels and
  remaining percentages; tooltips use the shared absolute reset formatter.
  Unconfigured or never-successfully collected sources stay absent rather than
  inventing a zero balance.
2. **Account balances — `deepseek`, `opencode`.** `balances[]` contains independent
  currency buckets with nullable `total_balance`, `topped_up_balance` and
  `granted_balance`; null remains unknown and a numeric zero remains a real zero.
  Cards render the currency amount, availability and a topped-up/granted
  breakdown. DeepSeek defaults to `GET https://api.deepseek.com/user/balance`
  with bearer authentication and `api.deepseek.com` as its allowed host. OpenCode
  uses its configured OpenCode base URL (`https://opencode.ai` by default) and the
  same balance/probe snapshot contract. Unavailable accounts and non-positive
  total balances are destructive states.
3. **Free-channel health — `jev_free`.** This source is credential-free. The
  server probes the configured OpenCode endpoint (default
  `https://opencode.ai/zen/v1/systemone`) with model `jev-1.13-free`, without
  business content, and stores `probe.available`, `probe.latency_ms` and the
  model. Cards show healthy/latency, abnormal or rate-limited state plus the last
  poll time; provider errors never get a healthy green treatment.

Global subscription reset times, refilled windows and interruption wording follow
the same display rules as Runtime quota. Balance and health observations use
elapsed past durations only for freshness; they do not manufacture reset times.
The old Runtime-level Thinking Adapt quota rows/cards are not alternate entry
points for these global monitors.

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
