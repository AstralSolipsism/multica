# Runtime subscription quota observations

Subscription quota is the provider account's allowance, not task token usage or
an estimate of money remaining. Runtimes sharing an account share its limits.

## Claude Code

The Claude adapter consumes `rate_limit_event` from the existing non-interactive
stream-json execution. It makes no quota API request and starts no idle poller.

- The documented `rate_limit_info` fields describe the limiting window.
- Claude Code 2.1.286 also emits `unifiedWindows`: five-hour, weekly and, when
  reported, model-specific weekly observations from response headers.
- Utilization is a fraction; multiply by 100 for `used_percent`. Zero is a real
  observation, missing is unknown, and legitimate values above 100 are retained.
- `resetsAt` is Unix seconds. Do not infer a refreshed allowance when a reset
  passes. The existing UI expires that window until another observation arrives.
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
