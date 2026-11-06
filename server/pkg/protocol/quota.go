package protocol

import "github.com/multica-ai/multica/server/internal/daemon/jev"

// Runtime plan quota and host metrics wire types.
//
// The plan-quota shape crosses the daemon -> server heartbeat boundary, the
// server -> client API boundary, the external push endpoint, and the
// agent_runtime.plan_quota JSONB column. Privacy red line: it must never
// carry account ids, plan names, credit balances, tokens, or credentials —
// only coarse percentages and window metadata.
//
// HostMetrics crosses the daemon -> server heartbeat boundary and the
// server -> client runtime list API, and is cached in Redis keyed by
// (workspace id, daemon id).

// Plan quota status values. PlanQuotaStatusLimited means the provider is
// rate limiting the account or the quota window is exhausted.
const (
	PlanQuotaStatusOK      = "ok"
	PlanQuotaStatusLimited = "limited"
)

// Plan quota provenance: observed by the daemon running the agent CLI, or
// pushed by an external integration through the quota report endpoint.
const (
	PlanQuotaSourceDaemon   = "daemon"
	PlanQuotaSourceExternal = "external"
	// PlanQuotaSourceSubscription marks snapshots written by the server-side
	// subscription quota-source poller (OL-1205 scenario 3).
	PlanQuotaSourceSubscription = "subscription"
)

// Validation bounds for RuntimePlanQuota. Server-side validation rejects
// anything outside these; heartbeat payloads that fail validation are
// dropped (the beat itself is still acked).
const (
	// PlanQuotaMaxWindows caps the window list so a malformed reporter
	// cannot bloat the JSONB column.
	PlanQuotaMaxWindows = 8
	// PlanQuotaMaxWindowName bounds window names ("primary", "secondary").
	PlanQuotaMaxWindowName = 32
	// PlanQuotaMaxGroupName bounds the optional quota-group label a window
	// may carry (antigravity's "gemini" / "claude_gpt" pools, OMP's provider
	// pool ids like "kimi-code").
	PlanQuotaMaxGroupName = 32
	// PlanQuotaMaxWindowMinutes is one year in minutes — a generous upper
	// bound that still rejects nonsense values.
	PlanQuotaMaxWindowMinutes = 525600
	// PlanQuotaMaxUsedPercent allows values above 100: some providers report
	// over-100 percentages when a window is oversubscribed, and clamping
	// would hide the overshoot.
	PlanQuotaMaxUsedPercent = 10000
)

// Bounds for the multi-account provider pools (OMP). The per-account window
// lists each stay under PlanQuotaMaxWindows; the pools carry the multi-account
// structure the flat window list cannot.
const (
	// PlanQuotaMaxAccountPools caps the provider pool list.
	PlanQuotaMaxAccountPools = 16
	// PlanQuotaMaxAccountsPerPool caps the account list inside one pool.
	PlanQuotaMaxAccountsPerPool = 32
	// PlanQuotaMaxAccountLabel bounds the redacted account label.
	PlanQuotaMaxAccountLabel = 64
	// PlanQuotaMaxAccountNote bounds the per-account note (e.g. the disabled
	// credential's cause).
	PlanQuotaMaxAccountNote = 128
)

// Per-account status values inside a provider pool. "reserve" is accepted for
// reporters that flag a reserve/threshold state OMP has not shipped yet.
const (
	PlanQuotaAccountOK        = "ok"
	PlanQuotaAccountWarning   = "warning"
	PlanQuotaAccountExhausted = "exhausted"
	PlanQuotaAccountReserve   = "reserve"
	PlanQuotaAccountDisabled  = "disabled"
	PlanQuotaAccountUnknown   = "unknown"
)

// RuntimePlanQuotaWindow describes one provider rate-limit window. Every
// numeric field is a pointer so a real 0 is distinguishable from
// "not reported" — the server must never fabricate a 0 the provider did
// not send.
type RuntimePlanQuotaWindow struct {
	// Name may be empty only when Group identifies the window. This accepts
	// snapshots from deployed antigravity daemons; new reporters set both.
	Name          string   `json:"name"`
	UsedPercent   *float64 `json:"used_percent,omitempty"`
	WindowMinutes *int64   `json:"window_minutes,omitempty"`
	// ResetsAt is unix seconds; nil when the provider did not disclose it.
	ResetsAt *int64 `json:"resets_at,omitempty"`
	// Group is the optional quota pool the window belongs to, for providers
	// that keep several independent pools per account (antigravity reports a
	// Gemini pool and a Claude/GPT pool, each with its own 5h and weekly
	// windows — four buckets that a flat window list would collapse).
	// Optional and free-form: reporters whose provider has a single pool
	// omit it, and the UI falls back to rendering ungrouped rows.
	Group string `json:"group,omitempty"`
}

// RuntimePlanQuota is the account-level plan/rate-limit snapshot for one
// runtime. It travels as "plan_quota" on daemon heartbeats, as the body of
// the external quota push endpoint, is stored in agent_runtime.plan_quota,
// and is exposed on the runtime list API as "plan_quota".
type RuntimePlanQuota struct {
	Provider string                   `json:"provider"`
	Status   string                   `json:"status"`
	Windows  []RuntimePlanQuotaWindow `json:"windows,omitempty"`
	// ObservedAt is unix seconds; required, and the freshness arbiter when
	// daemon and external reporters write the same row (newer wins).
	ObservedAt int64  `json:"observed_at"`
	Source     string `json:"source"`
	// AccountPools carries the multi-provider, multi-account structure of
	// gateways that pool several vendor subscriptions behind one runtime
	// (OMP). Optional: single-account providers omit it and keep using
	// Windows; a snapshot with pools may still carry a top-level Windows
	// summary. Pool account labels are redacted by the reporter (--redact);
	// the validator rejects labels that look like plaintext emails.
	AccountPools []RuntimePlanQuotaAccountPool `json:"account_pools,omitempty"`
}

// RuntimePlanQuotaAccountPool is one vendor's account pool inside a gateway
// runtime: every logged-in (redacted) account with its own windows, plus
// counts derived from the pool. Pool health is an OR across accounts — see
// the daemon-side collector; only a pool whose accounts are ALL unavailable
// is Exhausted, with ResumesAt = the earliest reset among its accounts.
type RuntimePlanQuotaAccountPool struct {
	// ID is the vendor id as the gateway reports it ("kimi-code",
	// "anthropic", "openai-codex", "zai"). Bounded to PlanQuotaMaxGroupName.
	ID string `json:"id"`
	// TotalAccounts / AvailableAccounts / DisabledAccounts describe the
	// pool: how many accounts are logged in, currently usable, and needing
	// re-login. Required: 0 total fails validation.
	TotalAccounts     int `json:"total_accounts"`
	AvailableAccounts int `json:"available_accounts"`
	DisabledAccounts  int `json:"disabled_accounts"`
	// Status is the OR-ed pool status: "ok" while at least one account is
	// usable, "limited" only when every account is unavailable.
	Status string `json:"status"`
	// ResumesAt is unix seconds; when the whole pool is down, the earliest
	// resets_at among its accounts, nil when unknown or not exhausted.
	ResumesAt *int64 `json:"resumes_at,omitempty"`
	// Accounts are the pool's redacted account entries. The list is capped
	// at PlanQuotaMaxAccountsPerPool.
	Accounts []RuntimePlanQuotaAccount `json:"accounts"`
}

// RuntimePlanQuotaAccount is one (redacted) account inside a pool. Label is
// the reporter's masked identifier ("19*", "ca*9*") — never an email; the
// validator rejects labels containing "@".
type RuntimePlanQuotaAccount struct {
	// Label is the redacted account identifier.
	Label string `json:"label"`
	// Status: ok | warning | exhausted | reserve | disabled | unknown.
	Status string `json:"status"`
	// Windows are this account's rate-limit windows (same shape as the
	// top-level list, ≤ PlanQuotaMaxWindows entries).
	Windows []RuntimePlanQuotaWindow `json:"windows,omitempty"`
	// Note is an optional short per-account note (e.g. why a credential is
	// disabled). Bounded; the validator rejects "@" inside it.
	Note string `json:"note,omitempty"`
}

// HostMetrics is one machine-level resource sample from the daemon host.
// It travels as "metrics" on daemon heartbeats, is cached in Redis keyed by
// (workspace id, daemon id), and is exposed on the runtime list API as
// "system_stats". Pointer fields distinguish a real 0% from "not sampled".
type HostMetrics struct {
	CPUPercent    *float64 `json:"cpu_percent,omitempty"`
	MemoryPercent *float64 `json:"memory_percent,omitempty"`
	// CapturedAt is unix seconds. The daemon's single host sampler stamps
	// one capture time per sampling cycle, so every runtime heartbeat of
	// the same daemon carries the same CapturedAt; the server stores only
	// the first (set-if-newer) and consumers treat stale samples as absent.
	CapturedAt int64 `json:"captured_at"`
}

// ThinkingAdaptSnapshot is the daemon's Jev health snapshot (contract §3)
// for adaptive thinking levels. It travels as "thinking_adapt" on daemon
// heartbeats of thinking-capable runtimes, is cached in Redis keyed by
// (workspace id, daemon id) like HostMetrics, and is exposed on the runtime
// list API as "thinking_adapt". Carries only source names — never URLs,
// keys, or run content.
type ThinkingAdaptSnapshot = jev.Snapshot
