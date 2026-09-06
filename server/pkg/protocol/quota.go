package protocol

// Runtime plan quota wire types.
//
// The shape crosses the daemon -> server heartbeat boundary, the server ->
// client API boundary, the external push endpoint, and the
// agent_runtime.plan_quota JSONB column. Privacy red line: it must never
// carry account ids, plan names, credit balances, tokens, or credentials —
// only coarse percentages and window metadata.

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
	// may carry (antigravity's "gemini" / "claude_gpt" pools).
	PlanQuotaMaxGroupName = 32
	// PlanQuotaMaxWindowMinutes is one year in minutes — a generous upper
	// bound that still rejects nonsense values.
	PlanQuotaMaxWindowMinutes = 525600
	// PlanQuotaMaxUsedPercent allows values above 100: some providers report
	// over-100 percentages when a window is oversubscribed, and clamping
	// would hide the overshoot.
	PlanQuotaMaxUsedPercent = 10000
)

// RuntimePlanQuotaWindow describes one provider rate-limit window. Every
// numeric field is a pointer so a real 0 is distinguishable from
// "not reported" — the server must never fabricate a 0 the provider did
// not send.
type RuntimePlanQuotaWindow struct {
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
}
