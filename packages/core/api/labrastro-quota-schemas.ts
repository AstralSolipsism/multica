import { z } from "zod";
import type { AgentRuntime } from "../types";


// ---------------------------------------------------------------------------
// Runtime plan-quota schemas. The snapshot rides along on each runtime
// object from `GET /api/runtimes` as an optional field. They are NOT wired
// through parseWithFallback at the endpoint — one malformed snapshot must not
// take down the whole runtime list — so the views layer sanitizes each
// runtime individually (see parsePlanQuota in core/runtimes/plan-quota).
// ---------------------------------------------------------------------------

// Strict per-window shape: a window whose fields fail to parse is dropped by
// the sanitizer, so the schema itself does not tolerate drift.
export const RuntimePlanQuotaWindowSchema = z.object({
  name: z.string().default(""),
  used_percent: z.number().nullable().default(null),
  window_minutes: z.number().nullable().default(null),
  resets_at: z.number().nullable().default(null),
  // Optional quota-pool label for providers that keep several independent
  // pools per account (antigravity reports a gemini pool and a claude_gpt
  // pool, each with 5h and weekly windows). Reporters with a single pool
  // omit it.
  group: z.string().nullish().default(null),
}).loose();

// One redacted account inside a gateway provider pool (OMP). The label is
// the reporter's masked identifier ("19*"); a label or note containing "@"
// is rejected so plaintext identities cannot cross the boundary.
const ACCOUNT_STATUSES = ["ok", "warning", "exhausted", "reserve", "disabled", "unknown"] as const;

export const RuntimePlanQuotaAccountSchema = z.object({
  label: z.string(),
  status: z.enum(ACCOUNT_STATUSES).catch("unknown"),
  windows: z.array(z.unknown()).catch([]),
  note: z.string().nullish().default(null),
  // A snapshot carrying an identity string is unusable, not partially usable.
}).loose().superRefine((account: { label: string; note: string | null }, ctx: z.RefinementCtx) => {
  if (account.label.includes("@") || (account.note ?? "").includes("@")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "identity string in account label/note" });
  }
});

// One vendor's account pool: all logged-in (redacted) accounts plus counts.
// `accounts` stays `unknown[]` (an element-level `.catch` would swallow the
// WHOLE array when one account fails): parseAccountPools re-parses each
// account and drops only the offending ones.
export const RuntimePlanQuotaAccountPoolSchema = z.object({
  id: z.string().min(1),
  total_accounts: z.number().int().nonnegative().default(0),
  available_accounts: z.number().int().nonnegative().default(0),
  disabled_accounts: z.number().int().nonnegative().default(0),
  status: z.string().default("ok"),
  resumes_at: z.number().nullable().default(null),
  accounts: z.array(z.unknown()).catch([]),
}).loose();

// `windows` stays `unknown[]` here on purpose: the sanitizer re-parses each
// window with RuntimePlanQuotaWindowSchema and drops the malformed ones
// instead of failing the whole snapshot.
export const RuntimePlanQuotaSchema = z.object({
  provider: z.string().default(""),
  status: z.string().default("ok"),
  windows: z.array(z.unknown()).default([]),
  observed_at: z.number().default(0),
  source: z.string().default(""),
  // Multi-account provider pools (OMP gateways). Older backends omit them.
  account_pools: z.array(z.unknown()).catch([]).optional(),
}).loose();

export type QuotaSourceKind = "glm" | "zenmux" | "deepseek" | "opencode" | "jev_free";
export type QuotaSourceVisibility = "private" | "shared";
// How an opencode source queries the account: the console billing API with a
// session Cookie ("payg") or the Zen Go-subscription usage API ("go").
export type QuotaSourceOpenCodeMode = "payg" | "go";

// One currency bucket of a pay-as-you-go account balance (deepseek,
// opencode). Amounts are nullable so a real 0 stays distinct from "not
// reported".
export const QuotaSourceBalanceSchema = z.object({
  currency: z.string().catch(""),
  total_balance: z.number().nullable().optional().catch(null),
  granted_balance: z.number().nullable().optional().catch(null),
  topped_up_balance: z.number().nullable().optional().catch(null),
  // Last-30-day spend for pay-as-you-go accounts; absent when the provider
  // did not report it.
  spend_30d: z.number().nullable().optional().catch(null),
}).loose();
export type QuotaSourceBalance = z.infer<typeof QuotaSourceBalanceSchema>;

// Free-tier / pay-as-you-go health probe outcome. `available` and
// `latency_ms` are required booleans/numbers in the server protocol and get
// NO catch here: a malformed probe fails the whole field, and the enclosing
// `.catch(null)` degrades it to `probe: null` instead of fabricating a
// healthy-looking measurement ("fast" → 0ms).
export const QuotaSourceProbeSchema = z.object({
  available: z.boolean(),
  latency_ms: z.number(),
  model: z.string().optional().catch(""),
}).loose();
export type QuotaSourceProbe = z.infer<typeof QuotaSourceProbeSchema>;

// The persisted quota_source snapshot: the plan-quota shape (windows for
// subscription kinds) plus the balance and probe payloads the global cards
// render. Backward compatible — glm/zenmux snapshots parse unchanged.
export const QuotaSourceSnapshotSchema = RuntimePlanQuotaSchema.extend({
  available: z.boolean().nullable().optional().catch(null),
  balances: z.optional(
    z.array(QuotaSourceBalanceSchema.nullable().catch(null)).catch([])
      .transform((balances) => balances.filter((balance) => balance !== null)),
  ),
  probe: QuotaSourceProbeSchema.nullable().optional().catch(null),
});
export type QuotaSourceSnapshot = z.infer<typeof QuotaSourceSnapshotSchema>;

export const QuotaSourceErrorSchema = z.object({
  code: z.string().catch(""),
  message: z.string().catch(""),
}).loose();
export type QuotaSourceError = z.infer<typeof QuotaSourceErrorSchema>;

export const QuotaSourceProbeErrorBodySchema = z.object({
  code: z.string().catch(""),
  reason: z.string().optional().catch(""),
  message: z.string().optional().catch(""),
}).loose();

const quotaSourceTimestamps = {
  last_polled_at: z.string().nullable().optional().catch(null),
  created_at: z.string().optional().catch(""),
  updated_at: z.string().optional().catch(""),
};

export const QuotaSourceSchema = z.object({
  id: z.string().catch(""),
  kind: z.string().catch(""),
  name: z.string().catch(""),
  base_url: z.string().nullable().optional().catch(null),
  credential_hint: z.string().optional().catch(""),
  // OpenCode query mode and optional workspace, persisted inside the sealed
  // credential envelope. Older backends omit them; the form falls back to
  // "go" for an existing source.
  opencode_mode: z.enum(["payg", "go"]).optional().catch(undefined),
  workspace_id: z.string().optional().catch(""),
  enabled: z.boolean().catch(false),
  visibility: z.string().catch("private"),
  quota: QuotaSourceSnapshotSchema.nullable().optional().catch(null),
  last_error: QuotaSourceErrorSchema.nullable().optional().catch(null),
  ...quotaSourceTimestamps,
}).loose();
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;

export const WorkspaceQuotaSourceSchema = z.object({
  id: z.string().catch(""),
  kind: z.string().catch(""),
  name: z.string().catch(""),
  owner_id: z.string().optional().catch(""),
  visibility: z.string().catch("private"),
  is_own: z.boolean().optional().catch(false),
  quota: QuotaSourceSnapshotSchema.nullable().optional().catch(null),
  last_polled_at: quotaSourceTimestamps.last_polled_at,
  last_error: QuotaSourceErrorSchema.nullable().optional().catch(null),
}).loose();
export type WorkspaceQuotaSource = z.infer<typeof WorkspaceQuotaSourceSchema>;

function identifiedSources<T extends { id: string }>(sources: (T | null)[]): T[] {
  return sources.filter((source): source is T => source !== null && source.id.length > 0);
}

export const QuotaSourceListResponseSchema = z.object({
  encryption_configured: z.boolean().catch(false),
  sources: z.array(QuotaSourceSchema.nullable().catch(null)).catch([])
    .transform(identifiedSources),
}).loose();
export type QuotaSourceListResponse = z.infer<typeof QuotaSourceListResponseSchema>;

export const WorkspaceQuotaSourceListResponseSchema = z.object({
  sources: z.array(WorkspaceQuotaSourceSchema.nullable().catch(null)).catch([])
    .transform(identifiedSources),
}).loose();
export type WorkspaceQuotaSourceListResponse = z.infer<typeof WorkspaceQuotaSourceListResponseSchema>;

export const EMPTY_QUOTA_SOURCE_LIST: QuotaSourceListResponse = {
  encryption_configured: false,
  sources: [],
};
export const EMPTY_WORKSPACE_QUOTA_SOURCE_LIST: WorkspaceQuotaSourceListResponse = {
  sources: [],
};

export interface CreateQuotaSourceInput {
  kind: QuotaSourceKind;
  // Optional: the server falls back to the channel's short default name.
  name: string;
  // Credential-free kinds (jev_free) may omit or empty the credential.
  credential?: string;
  base_url?: string;
  visibility: QuotaSourceVisibility;
  // opencode only.
  opencode_mode?: QuotaSourceOpenCodeMode;
  workspace_id?: string;
}

export interface UpdateQuotaSourceInput {
  name?: string;
  credential?: string;
  base_url?: string;
  enabled?: boolean;
  visibility?: QuotaSourceVisibility;
  // opencode only: omit to keep the stored value, send "" to clear.
  opencode_mode?: QuotaSourceOpenCodeMode;
  workspace_id?: string;
}

// Machine-level CPU/memory sample. `stale` is computed by the server at read
// time and defaults to false for older backends. Unlike plan_quota (helper-
// parsed per runtime, see the note above), system_stats is validated at the
// API boundary via RuntimeListItemSchema: a malformed sample degrades to null
// for that row only. parseSystemStats (core/runtimes/host-metrics) remains as
// the views layer's defensive re-check (it also rejects captured_at <= 0).
export const RuntimeSystemStatsSchema = z.object({
  cpu_percent: z.number().nullable().default(null),
  memory_percent: z.number().nullable().default(null),
  captured_at: z.number().default(0),
  stale: z.boolean().default(false),
}).loose();

// Jev health snapshot for adaptive thinking (contract §3), riding the
// runtime list as "thinking_adapt". Loose by design: fields default rather
// than fail, and `status` stays a plain string so an unrecognized status
// from a newer daemon passes through instead of losing the snapshot — the
// UI renders anything outside the four known values as a neutral state.
export const RuntimeThinkingAdaptSchema = z.object({
  status: z.string().catch(""),
  active_source: z.string().default(""),
  last_latency_ms: z.number().default(0),
  decisions_ok: z.number().default(0),
  decisions_fallback: z.number().default(0),
  since: z.string().nullable().catch(null),
  updated_at: z.string().nullable().catch(null),
}).loose();

// Runtime list items are parsed loosely at the boundary: every field passes
// through untouched except system_stats, which is schema-validated per row —
// a malformed one becomes null (the UI's not-reported state) without taking
// down the rest of the list. A wholly malformed response falls back to [].
export const RuntimeListItemSchema = z.object({
  shared_with: z.array(z.string().uuid()).catch([]),
  max_concurrent_tasks: z.number().int().nullable().catch(null),
  system_stats: RuntimeSystemStatsSchema.nullable().catch(null),
  thinking_adapt: RuntimeThinkingAdaptSchema.nullable().catch(null),
}).loose();

export const RuntimeListSchema = z.array(RuntimeListItemSchema);

// Fallback for a wholly malformed runtime list response (not an array of
// objects at all): the caller renders an empty list rather than crashing.
export const EMPTY_RUNTIME_LIST: AgentRuntime[] = [];
