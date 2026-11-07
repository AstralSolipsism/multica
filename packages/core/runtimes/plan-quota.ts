// Pure helpers for the runtime plan-quota snapshot (`RuntimeDevice.plan_quota`
// — optional, older backends omit it). Parsing degrades to "no data" (null /
// empty) instead of throwing or inventing numbers. evaluatePlanQuota derives
// what the UI shows: a window whose reset has passed counts as refilled, and a
// used-up window blocks the rest of its pool until it resets.

import type {
  Agent,
  PlanQuotaAccountStatus,
  RuntimePlanQuota,
  RuntimePlanQuotaAccount,
  RuntimePlanQuotaAccountPool,
  RuntimePlanQuotaWindow,
} from "../types";
import {
  RuntimePlanQuotaAccountPoolSchema,
  RuntimePlanQuotaAccountSchema,
  RuntimePlanQuotaSchema,
  RuntimePlanQuotaWindowSchema,
} from "../api/schemas";
import { parseOmpRuntimeConfig } from "../agents/omp-runtime-config";

export type QuotaTone = "ok" | "warning" | "destructive";

// Collectors poll every two minutes and can back off for up to 30 minutes.
const COLLECTOR_QUOTA_INTERRUPTED_MS = 3600 * 1000;
// Matches the daemon's Kimi, OMP and Antigravity quota collectors and the
// server-side subscription quota-source poller.
const COLLECTOR_QUOTA_PROVIDERS = ["kimi", "antigravity", "zenmux", "omp"];

function modelProviderPrefix(model: string | null | undefined): string | null {
  const value = model?.trim() ?? "";
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const provider = value.slice(0, slash).trim();
  return provider || null;
}

function customArgsModel(args: string[]): string | null {
  let model: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === "--model" || arg === "-m") && args[index + 1]) {
      model = args[index + 1]!;
      index++;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    }
  }
  return model;
}

/** Provider prefixes from unarchived agents bound to this runtime. */
export function servingAccountPoolProviders(
  agents: Agent[],
  runtimeId: string,
): Set<string> {
  const providers = new Set<string>();
  const addModel = (model: string | undefined) => {
    const provider = modelProviderPrefix(model);
    if (provider) providers.add(provider);
  };
  for (const agent of agents) {
    if (agent.runtime_id !== runtimeId || agent.archived_at) continue;
    addModel(customArgsModel(agent.custom_args ?? []) ?? agent.model ?? undefined);
    const config = parseOmpRuntimeConfig(agent.runtime_config);
    addModel(config.smolModel);
    if (config.advisorEnabled) addModel(config.slowModel);
    if (config.executionMode) {
      addModel(config.planModel);
      addModel(config.handoffModel);
    }
  }
  return providers;
}

/**
 * Sanitize a raw `plan_quota` payload. A malformed snapshot returns null
 * (caller renders the not-reported state); a single malformed window is
 * dropped while the well-formed ones survive. Never throws.
 */
export function parsePlanQuota(raw: unknown): RuntimePlanQuota | null {
  if (raw == null) return null;
  const parsed = RuntimePlanQuotaSchema.safeParse(raw);
  if (!parsed.success) return null;
  const windows: RuntimePlanQuotaWindow[] = [];
  for (const candidate of parsed.data.windows) {
    const result = RuntimePlanQuotaWindowSchema.safeParse(candidate);
    if (result.success) {
      windows.push({
        name: result.data.name,
        used_percent: result.data.used_percent,
        window_minutes: result.data.window_minutes,
        resets_at: result.data.resets_at,
        group: result.data.group,
      });
    }
  }
  const accountPools = parseAccountPools(parsed.data.account_pools);
  return {
    provider: parsed.data.provider,
    status: parsed.data.status === "limited" ? "limited" : "ok",
    windows,
    observed_at: parsed.data.observed_at,
    source: parsed.data.source,
    ...(accountPools ? { account_pools: accountPools } : {}),
  };
}

/**
 * Sanitize the multi-account provider pools. Each pool is re-parsed
 * independently: one malformed pool drops out while the well-formed ones
 * survive, and the per-account windows go through the same per-window
 * sanitizer as the flat list.
 */
export function parseAccountPools(
  raw: unknown,
): RuntimePlanQuotaAccountPool[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pools: RuntimePlanQuotaAccountPool[] = [];
  for (const candidate of raw) {
    const result = RuntimePlanQuotaAccountPoolSchema.safeParse(candidate);
    if (!result.success) continue;
    const p = result.data;
    const accounts: RuntimePlanQuotaAccount[] = [];
    for (const rawAccount of p.accounts) {
      const account = RuntimePlanQuotaAccountSchema.safeParse(rawAccount);
      if (!account.success) continue;
      const windows: RuntimePlanQuotaWindow[] = [];
      for (const candidateWindow of account.data.windows) {
        const w = RuntimePlanQuotaWindowSchema.safeParse(candidateWindow);
        if (w.success) {
          windows.push({
            name: w.data.name,
            used_percent: w.data.used_percent,
            window_minutes: w.data.window_minutes,
            resets_at: w.data.resets_at,
            group: w.data.group,
          });
        }
      }
      accounts.push({
        label: account.data.label,
        status: account.data.status,
        windows,
        note: account.data.note ?? null,
      });
    }
    pools.push({
      id: p.id,
      total_accounts: p.total_accounts,
      available_accounts: p.available_accounts,
      disabled_accounts: p.disabled_accounts,
      status: p.status === "limited" ? "limited" : "ok",
      resumes_at: p.resumes_at,
      accounts,
    });
  }
  return pools.length > 0 ? pools : null;
}

/**
 * A quota window's quota pool, normalized to null for ungrouped reporters.
 * Generic over the window shape so both raw wire windows and view models
 * group identically.
 */
export function quotaWindowGroup(
  window: { name: string; group?: string | null },
): string | null {
  const group = window.group?.trim();
  return group ? group : null;
}

/**
 * Windows grouped by quota pool for grouped display (the antigravity detail /
 * settings cards show every pool under its own label). Order is stable: the
 * documented antigravity pools first (gemini, then claude_gpt), unknown pools
 * after them in first-seen order, and ungrouped windows trailing as a null
 * group so a reporter without groups renders exactly as it did before the
 * field existed.
 */
export function groupQuotaWindows<T extends { name: string; group?: string | null }>(
  windows: T[],
): { group: string | null; windows: T[] }[] {
  const DOCUMENTED_ORDER = ["gemini", "claude_gpt"];
  const groups: { group: string | null; windows: T[] }[] = [];
  const firstSeen = new Map<string, { group: string | null; windows: T[] }>();
  for (const window of windows) {
    const group = quotaWindowGroup(window);
    const key = group ?? "\0ungrouped";
    let bucket = firstSeen.get(key);
    if (bucket == null) {
      bucket = { group, windows: [] };
      firstSeen.set(key, bucket);
      groups.push(bucket);
    }
    bucket.windows.push(window);
  }
  const rank = (group: string | null): number => {
    if (group == null) return DOCUMENTED_ORDER.length + 1;
    const at = DOCUMENTED_ORDER.indexOf(group);
    return at === -1 ? DOCUMENTED_ORDER.length : at;
  };
  // Array#sort is stable, so equal ranks keep first-seen order.
  return groups.sort((a, b) => rank(a.group) - rank(b.group));
}

/** Remaining percentage of a quota window; null when the provider only
 *  signals exhaustion without a percentage. */
export function windowRemainingPercent(
  window: RuntimePlanQuotaWindow,
): number | null {
  if (window.used_percent == null) return null;
  return 100 - window.used_percent;
}

/** A polled observation older than an hour means collection stopped. The
 *  last balance stays visible but is no longer current. */
export function isCollectorObservationInterrupted(
  observedAtSec: number,
  nowMs: number,
): boolean {
  return nowMs - observedAtSec * 1000 > COLLECTOR_QUOTA_INTERRUPTED_MS;
}

/** Only polling collectors can be interrupted. Task-reported providers
 *  observe quota while a task runs, so no new observation means no usage:
 *  their last balance holds until its reset time. */
export function isQuotaCollectionInterrupted(
  quota: RuntimePlanQuota,
  nowMs: number,
): boolean {
  return (
    COLLECTOR_QUOTA_PROVIDERS.includes(quota.provider) &&
    isCollectorObservationInterrupted(quota.observed_at, nowMs)
  );
}

export function quotaTone(remaining: number | null): QuotaTone {
  if (remaining != null && remaining <= 10) return "destructive";
  if (remaining != null && remaining <= 20) return "warning";
  return "ok";
}

/** One window after reset inference and the pool rules. Times are unix
 *  seconds. */
export interface QuotaWindowState {
  name: string;
  group: string | null;
  windowMinutes: number | null;
  /** 100 once the reset has passed; null when the provider sent no
   *  percentage. */
  remainingPercent: number | null;
  /** The upcoming reset; null once it has passed or when unknown. */
  resetsAt: number | null;
  /** The passed reset that refilled the window; null otherwise. */
  resetPassedAt: number | null;
  /** Used up: blocks its pool until it resets. */
  exhausted: boolean;
  /** Its limited pool recovers no earlier than this window resets (or the
   *  window reports no reset), so its balance does not matter until then.
   *  Never set on the used-up windows the recovery waits for. */
  notApplicable: boolean;
  tone: QuotaTone;
}

/** Windows sharing a quota pool: one per group, ungrouped windows form one. */
export interface QuotaPoolState {
  group: string | null;
  windows: QuotaWindowState[];
  limited: boolean;
  /** The binding window's remaining percent; null when limited or when no
   *  window carries a percentage. */
  remainingPercent: number | null;
  /** Limited: when the pool recovers, i.e. the latest reset among its
   *  used-up windows (null if one is unknown). Otherwise the binding
   *  window's reset. */
  resetsAt: number | null;
  tone: QuotaTone;
}

/** The tightest constraint across pools, for single-value surfaces. */
export interface QuotaSummary {
  limited: boolean;
  remainingPercent: number | null;
  resetsAt: number | null;
  tone: QuotaTone;
}

export interface PlanQuotaState {
  provider: string;
  source: string;
  observedAt: number;
  pools: QuotaPoolState[];
  /** Every window names its pool and no pool constrains another
   *  (antigravity's gemini and claude_gpt): summarize each pool on its own. */
  independentPools: boolean;
  /** Limited, yet no window was used up when observed and every window has
   *  a percentage: the limit belongs to no window or pool, so the snapshot
   *  is limited as a whole, with no recovery time, until it is replaced. */
  unattributedLimit: boolean;
  summary: QuotaSummary;
  /** A collector stopped reporting: the last balance stays, flagged. */
  interrupted: boolean;
}

/**
 * Derive the display state of a snapshot. A passed reset refills its window
 * (100%, no next reset). Per pool, a used-up window limits the pool until
 * the latest reset among its used-up windows; every other window that
 * resets by then, or reports no reset, is not applicable meanwhile. A pool
 * without a used-up window is bound by its least remaining window, the
 * later reset winning a tie. A limited snapshot that names no used-up
 * window is limited as a whole: no window is guessed, so nothing tells when
 * it recovers.
 */
export function evaluatePlanQuota(
  quota: RuntimePlanQuota,
  nowMs: number,
): PlanQuotaState {
  const nowSec = Math.floor(nowMs / 1000);
  const usedUp = usedUpAtObservation(quota);
  const unattributedLimit = quota.status === "limited" && usedUp.size === 0;
  const pools = groupQuotaWindows(quota.windows).map(({ group, windows }) =>
    evaluateQuotaPool(group, windows, usedUp, nowSec),
  );
  return {
    provider: quota.provider,
    source: quota.source,
    observedAt: quota.observed_at,
    pools,
    // A limit that belongs to no pool cannot be split across pools.
    independentPools:
      !unattributedLimit &&
      quota.windows.length > 0 &&
      quota.windows.every((window) => quotaWindowGroup(window) != null),
    unattributedLimit,
    summary: unattributedLimit
      ? { limited: true, remainingPercent: null, resetsAt: null, tone: "destructive" }
      : summarizeQuotaPools(pools),
    interrupted: isQuotaCollectionInterrupted(quota, nowMs),
  };
}

/** A raw `plan_quota` payload's display state; null when nothing usable was
 *  reported (missing, malformed, or with neither windows nor pools). */
export function planQuotaState(raw: unknown, nowMs: number): PlanQuotaState | null {
  const quota = parsePlanQuota(raw);
  if (!quota) return null;
  if (quota.windows.length === 0 && (quota.account_pools?.length ?? 0) === 0) {
    return null;
  }
  return evaluatePlanQuota(quota, nowMs);
}

// Windows that were used up when observed. A full window always counts. A
// limited snapshot without one counts its windows that carry no percentage;
// with none of those either, its limit names no window.
function usedUpAtObservation(
  quota: RuntimePlanQuota,
): Set<RuntimePlanQuotaWindow> {
  const full = quota.windows.filter(
    (window) => window.used_percent != null && window.used_percent >= 100,
  );
  if (full.length > 0 || quota.status !== "limited") return new Set(full);
  return new Set(quota.windows.filter((window) => window.used_percent == null));
}

function evaluateQuotaPool(
  group: string | null,
  windows: RuntimePlanQuotaWindow[],
  usedUp: Set<RuntimePlanQuotaWindow>,
  nowSec: number,
): QuotaPoolState {
  const observed = windows.map((window) => {
    const passed = window.resets_at != null && window.resets_at <= nowSec;
    return {
      window,
      passed,
      exhausted: !passed && usedUp.has(window),
      remaining: passed ? 100 : windowRemainingPercent(window),
      resetsAt: passed ? null : window.resets_at,
    };
  });
  const exhausted = observed.filter((entry) => entry.exhausted);
  const limited = exhausted.length > 0;
  const recoverAt = latestReset(exhausted.map((entry) => entry.resetsAt));
  const states = observed.map((entry): QuotaWindowState => {
    // The used-up windows resetting last hold the pool. Any other window,
    // used up or not, that resets by then or reports no reset is set aside.
    const holdsPool = entry.exhausted && recoverAt != null && entry.resetsAt === recoverAt;
    const notApplicable =
      limited &&
      !holdsPool &&
      (entry.resetsAt == null || (recoverAt != null && entry.resetsAt <= recoverAt));
    return {
      name: entry.window.name,
      group,
      windowMinutes: entry.window.window_minutes,
      remainingPercent: entry.remaining,
      resetsAt: entry.resetsAt,
      resetPassedAt: entry.passed ? entry.window.resets_at : null,
      exhausted: entry.exhausted,
      notApplicable,
      tone: notApplicable
        ? "ok"
        : entry.exhausted
          ? "destructive"
          : quotaTone(entry.remaining),
    };
  });
  if (limited) {
    return {
      group,
      windows: states,
      limited,
      remainingPercent: null,
      resetsAt: recoverAt,
      tone: "destructive",
    };
  }
  const binding = tightest(states);
  return {
    group,
    windows: states,
    limited,
    remainingPercent: binding?.remainingPercent ?? null,
    resetsAt: binding?.resetsAt ?? null,
    tone: quotaTone(binding?.remainingPercent ?? null),
  };
}

function summarizeQuotaPools(pools: QuotaPoolState[]): QuotaSummary {
  const limited = pools.filter((pool) => pool.limited);
  if (limited.length > 0) {
    return {
      limited: true,
      remainingPercent: null,
      resetsAt: latestReset(limited.map((pool) => pool.resetsAt)),
      tone: "destructive",
    };
  }
  const binding = tightest(pools);
  return {
    limited: false,
    remainingPercent: binding?.remainingPercent ?? null,
    resetsAt: binding?.resetsAt ?? null,
    tone: quotaTone(binding?.remainingPercent ?? null),
  };
}

// The latest of a set of resets; null when the set is empty or any one is
// unknown, since the last of them decides recovery.
function latestReset(resets: (number | null)[]): number | null {
  if (resets.length === 0 || resets.some((reset) => reset == null)) return null;
  return Math.max(...(resets as number[]));
}

// The entry with the least remaining percent; on a tie, the later reset binds
// longer (an unknown reset counts as latest). Entries without a percentage
// cannot be ranked.
function tightest<T extends { remainingPercent: number | null; resetsAt: number | null }>(
  entries: T[],
): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    if (entry.remainingPercent == null) continue;
    if (
      best == null ||
      entry.remainingPercent < best.remainingPercent! ||
      (entry.remainingPercent === best.remainingPercent &&
        resetsLater(entry.resetsAt, best.resetsAt))
    ) {
      best = entry;
    }
  }
  return best;
}

function resetsLater(a: number | null, b: number | null): boolean {
  if (a == null) return b != null;
  return b != null && a > b;
}

/** Structured short label for a quota window: 300 → {unit:"hours",value:5}
 *  ("5h"), 10080 → {unit:"weekly"} ("7d"); generic fallback minutes /
 *  hours / days. Null when the window carries no duration — the caller falls
 *  back to the window's own name. Presentation-neutral: the views layer maps
 *  the descriptor to its i18n strings. */
export type QuotaWindowLabel =
  | { unit: "weekly" }
  | { unit: "minutes" | "hours" | "days"; value: number };

export function quotaWindowLabel(
  windowMinutes: number | null,
): QuotaWindowLabel | null {
  if (windowMinutes == null || windowMinutes <= 0) return null;
  if (windowMinutes === 10080) return { unit: "weekly" };
  if (windowMinutes % 1440 === 0) {
    return { unit: "days", value: windowMinutes / 1440 };
  }
  if (windowMinutes % 60 === 0) {
    return { unit: "hours", value: windowMinutes / 60 };
  }
  return { unit: "minutes", value: windowMinutes };
}

/** Compact duration for reset countdowns / snapshot ages: "2h 13m" at the
 *  hour scale, explicit units under an hour ("7m 2s", "45s"). */
export function formatCompactDuration(ms: number): string {
  const clamped = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Multi-account provider pools (OMP gateways). A gateway snapshot's flat
// window list is empty; all structure lives in account_pools. Pool health is
// PARALLEL (OR) across accounts — the opposite of the single-account
// tightest-window (AND) logic above: OMP switches to a sibling account when
// one is limited, so one exhausted account of three is 2/3 available, not
// exhausted. A pool is limited only when EVERY account is unavailable, and
// then it recovers at the earliest reset among them.
// ---------------------------------------------------------------------------

/** An account is usable only in its healthy states. "reserve" (inside its
 *  Usage Reserve) and "unknown" are NOT usable, but they are also not
 *  evidence of exhaustion — see evaluateQuotaAccountPool. */
export function planQuotaAccountUsable(status: PlanQuotaAccountStatus): boolean {
  return status === "ok" || status === "warning";
}

/** One account's display state inside a pool. */
export interface QuotaAccountState {
  label: string;
  status: PlanQuotaAccountStatus;
  usable: boolean;
  note: string | null;
  windows: QuotaWindowState[];
}

/** One provider pool's display state, OR-ed across its accounts. */
export interface QuotaAccountPoolState {
  id: string;
  accounts: QuotaAccountState[];
  /** Pool-level balances aggregated across non-disabled accounts. */
  windows: QuotaWindowState[];
  totalAccounts: number;
  availableAccounts: number;
  disabledAccounts: number;
  /** False while at least one account is usable (parallel OR). */
  exhausted: boolean;
  /** The pool's recovery time when exhausted: the earliest upcoming reset
   *  among its accounts (null when unknown or not exhausted). */
  resumesAt: number | null;
  /** Zero-based account index owning resumesAt, for the recovery label. */
  resumesAccountIndex: number | null;
  tone: QuotaTone;
}

/** A gateway snapshot's summary: the tightest pool constraint, OR-ed inside
 *  each pool and AND-ed across pools for the overall banner. */
export interface PlanQuotaPoolsSummary {
  pools: QuotaAccountPoolState[];
  /** Every pool is down. */
  exhausted: boolean;
  /** Unix seconds; when exhausted, the earliest pool recovery; else the
   *  earliest next reset among usable accounts' binding windows. */
  resumesAt: number | null;
  tone: QuotaTone;
}

/** Derive one account's windows and status from a sanitized snapshot. A
 *  window whose reset has passed counts as refilled, exactly like the flat
 *  list. An account is exhausted when its snapshot says so or any window is
 *  used up (single-account AND, inside the account). */
function evaluateQuotaAccount(
  account: RuntimePlanQuotaAccount,
  nowSec: number,
): QuotaAccountState {
  const windows: QuotaWindowState[] = [];
  let anyExhausted = false;
  for (const window of account.windows) {
    const passed = window.resets_at != null && window.resets_at <= nowSec;
    const remaining = passed ? 100 : windowRemainingPercent(window);
    const exhausted = !passed && window.used_percent != null && window.used_percent >= 100;
    if (exhausted) anyExhausted = true;
    windows.push({
      name: window.name,
      group: window.group ?? null,
      windowMinutes: window.window_minutes,
      remainingPercent: remaining,
      resetsAt: passed ? null : window.resets_at,
      resetPassedAt: passed ? window.resets_at : null,
      exhausted,
      notApplicable: false,
      tone: exhausted ? "destructive" : quotaTone(remaining),
    });
  }
  let status = account.status;
  if (anyExhausted && status !== "disabled") {
    status = "exhausted";
  } else if (
    status === "exhausted" &&
    !anyExhausted &&
    windows.some((window) => window.resetPassedAt != null)
  ) {
    // The snapshot said exhausted and every used-up window has since
    // refilled (a reset passed): the account recovers with its windows.
    // Without a passed reset the snapshot's exhausted stands — OMP denies
    // accounts below 100% too (e.g. a reached spend cap), and only OMP
    // knows that.
    status = "ok";
  }
  return {
    label: account.label,
    status,
    usable: planQuotaAccountUsable(status),
    note: account.note,
    windows,
  };
}

/** Aggregate matching account windows by duration. Disabled credentials carry
 *  no live balance and stay out of the mean; unknown values stay unknown
 *  instead of being counted as zero. */
function aggregateAccountPoolWindows(
  accounts: QuotaAccountState[],
): QuotaWindowState[] {
  const groups = new Map<string, QuotaWindowState[]>();
  for (const account of accounts) {
    if (account.status === "disabled") continue;
    for (const window of account.windows) {
      const key = window.windowMinutes != null
        ? `duration:${window.windowMinutes}`
        : `name:${window.name}`;
      const group = groups.get(key) ?? [];
      group.push(window);
      groups.set(key, group);
    }
  }
  return Array.from(groups.values()).map((windows) => {
    const first = windows[0]!;
    const measured = windows.filter((window) => window.remainingPercent != null);
    const remainingPercent = measured.length > 0
      ? measured.reduce((sum, window) => sum + window.remainingPercent!, 0) / measured.length
      : null;
    const resets = windows
      .map((window) => window.resetsAt)
      .filter((reset): reset is number => reset != null);
    return {
      name: first.name,
      group: null,
      windowMinutes: first.windowMinutes,
      remainingPercent,
      resetsAt: resets.length > 0 ? Math.min(...resets) : null,
      resetPassedAt: null,
      exhausted: remainingPercent === 0,
      notApplicable: false,
      tone: quotaTone(remainingPercent),
    };
  });
}

/** Recovery time of ONE account: the LATEST reset among its exhausted
 *  windows — an account's windows are serial (AND), so it is unusable until
 *  the last of them resets. Null when no exhausted window discloses a
 *  reset. */
function accountRecovery(
  account: QuotaAccountState,
): number | null {
  let latest: number | null = null;
  for (const window of account.windows) {
    if (!window.exhausted) continue;
    if (window.resetsAt == null) continue;
    if (latest == null || window.resetsAt > latest) {
      latest = window.resetsAt;
    }
  }
  return latest;
}

/** OR-evaluate one provider pool. */
function evaluateQuotaAccountPool(
  pool: RuntimePlanQuotaAccountPool,
  nowSec: number,
): QuotaAccountPoolState {
  const accounts = pool.accounts.map((account) => evaluateQuotaAccount(account, nowSec));
  const availableAccounts = accounts.filter((account) => account.usable).length;
  const disabledAccounts = accounts.filter((account) => account.status === "disabled").length;
  // Trust the pool's reported counts when the account list was truncated
  // or an account failed sanitization; the evaluated list stays the truth
  // for what is on screen.
  const totalAccounts = Math.max(pool.total_accounts, accounts.length);
  // Unknown accounts are missing evidence, not exhaustion: a pool whose
  // every account is unknown (usage endpoint failed, nothing measured)
  // renders neutral, never "exhausted". A pool is exhausted only when it
  // has accounts and every one of them is KNOWN-unavailable.
  const knownAccounts = accounts.filter((account) => account.status !== "unknown").length;
  const exhausted =
    accounts.length > 0 &&
    knownAccounts > 0 &&
    availableAccounts === 0;
  // Pool recovery: earliest per-account recovery (each account waits for
  // its own latest exhausted-window reset).
  let resumesAt: number | null = null;
  let resumesAccountIndex: number | null = null;
  if (exhausted) {
    accounts.forEach((account, index) => {
      const recovery = accountRecovery(account);
      if (recovery != null && (resumesAt == null || recovery < resumesAt)) {
        resumesAt = recovery;
        resumesAccountIndex = index;
      }
    });
  }
  const windows = aggregateAccountPoolWindows(accounts);
  const binding = tightest(windows);
  return {
    id: pool.id,
    accounts,
    windows,
    totalAccounts,
    availableAccounts,
    disabledAccounts,
    exhausted,
    resumesAt,
    resumesAccountIndex,
    tone: exhausted ? "destructive" : quotaTone(binding?.remainingPercent ?? null),
  };
}

/** Evaluate a gateway snapshot's account pools and summarize. */
export function evaluatePlanQuotaPools(
  quota: RuntimePlanQuota,
  nowMs: number,
): PlanQuotaPoolsSummary | null {
  const pools = quota.account_pools;
  if (!pools || pools.length === 0) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const evaluated = pools.map((pool) => evaluateQuotaAccountPool(pool, nowSec));
  const exhausted = evaluated.length > 0 && evaluated.every((pool) => pool.exhausted);
  // When everything is down the runtime recovers with the FIRST pool, so an
  // unknown pool resume never hides a known one (latestReset's all-or-null
  // is wrong here by construction).
  const resumes = evaluated
    .map((pool) => pool.resumesAt)
    .filter((at): at is number => at != null);
  const resumesAt = exhausted && resumes.length > 0 ? Math.min(...resumes) : null;
  const tone: QuotaTone = exhausted || evaluated.some((pool) => pool.tone === "destructive")
    ? "destructive"
    : evaluated.some((pool) => pool.tone === "warning")
      ? "warning"
      : "ok";
  return {
    pools: evaluated,
    exhausted,
    resumesAt,
    tone,
  };
}
