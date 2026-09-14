import type { AutopilotTrigger, WebhookEventFilter } from "../types";

/**
 * Compose a usable absolute webhook URL for a webhook trigger.
 *
 * Resolution order:
 *  1. trigger.webhook_url — present only when MULTICA_PUBLIC_URL is set on the
 *     server. This is the authoritative form when available.
 *  2. apiBaseUrl + webhook_path — desktop apps and self-host setups where the
 *     server didn't mint an absolute URL but the client knows its API origin.
 *  3. currentOrigin + webhook_path — browser fallback when getBaseUrl() is
 *     empty (e.g. same-origin Next.js dev).
 *
 * Returns null when the trigger has no token / path yet (a new trigger that
 * hasn't been written back to the cache, or a non-webhook trigger).
 */
export function buildAutopilotWebhookUrl(params: {
  trigger: Pick<AutopilotTrigger, "kind" | "webhook_token" | "webhook_path" | "webhook_url">;
  apiBaseUrl?: string;
  currentOrigin?: string;
}): string | null {
  const { trigger, apiBaseUrl, currentOrigin } = params;

  if (trigger.kind !== "webhook") return null;

  if (typeof trigger.webhook_url === "string" && trigger.webhook_url) {
    return trigger.webhook_url;
  }

  const path =
    (typeof trigger.webhook_path === "string" && trigger.webhook_path) ||
    (trigger.webhook_token ? `/api/webhooks/autopilots/${trigger.webhook_token}` : null);
  if (!path) return null;

  const base = stripTrailingSlash(apiBaseUrl) || stripTrailingSlash(currentOrigin);
  if (!base) return path; // last resort — relative path will still work in-browser
  return base + path;
}

function stripTrailingSlash(s: string | undefined): string {
  if (!s) return "";
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Stable JSON form of an event-filter draft for dirty checks and query keys.
 * Normalizes omitted Actions to [] so omitted-vs-explicit-empty doesn't read
 * as a phantom difference.
 */
export function serializeWebhookEventFilters(
  filters: Pick<WebhookEventFilter, "event" | "actions">[],
): string {
  return JSON.stringify(
    filters.map((f) => ({ event: f.event, actions: f.actions ?? [] })),
  );
}

/**
 * Merge a server-derived filter suggestion into an existing draft (OL-78).
 * Pure append with coverage dedupe: a same-event row with empty actions
 * already accepts every action, and an identical row is already present in
 * effect — in both cases the suggestion adds nothing, so no redundant row is
 * appended. Rows combine with OR server-side, so order carries no semantics.
 */
export function mergeWebhookFilterSuggestion(
  saved: WebhookEventFilter[],
  suggestion: WebhookEventFilter,
): WebhookEventFilter[] {
  const actions = suggestion.actions ?? [];
  const covered = saved.some((f) => {
    if (f.event !== suggestion.event) return false;
    const existing = f.actions ?? [];
    if (existing.length === 0) return true;
    if (existing.length !== actions.length) return false;
    const a = [...existing].sort();
    const b = [...actions].sort();
    return a.every((v, i) => v === b[i]);
  });
  if (covered) return [...saved];
  const row: WebhookEventFilter = { event: suggestion.event };
  if (actions.length > 0) row.actions = [...actions];
  return [...saved, row];
}

/** Fixed-width run — never derived from the token, so the mask leaks no length. */
const WEBHOOK_URL_MASK = "••••••••••••";

/**
 * Mask the secret part of a webhook URL for display.
 *
 * Only the trailing token segment is a credential: anyone holding it can fire
 * the autopilot. The origin and the `/api/webhooks/autopilots/` prefix carry no
 * secret, so they stay readable and the value is still recognizable as this
 * trigger's URL while hidden. Falls back to the bare mask when the URL has no
 * separable last segment.
 */
export function maskAutopilotWebhookUrl(url: string): string {
  const cut = url.lastIndexOf("/");
  if (cut < 0 || cut === url.length - 1) return WEBHOOK_URL_MASK;
  return url.slice(0, cut + 1) + WEBHOOK_URL_MASK;
}
