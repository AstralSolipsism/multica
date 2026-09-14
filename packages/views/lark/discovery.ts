import { ApiError, errorCode } from "@multica/core/api";
import type {
  LarkAnchorsPage,
  LarkChatsPage,
  LarkDiscoveredChat,
  LarkMessageAnchor,
  LarkPrivateChatCandidate,
} from "@multica/core/types";

// Pure helpers for the Lark target pickers (OL-74). Canonical home of the
// error-code mapping and the page-merge rules from
// server/internal/messagedelivery/TARGET-DISCOVERY-CONTRACT.md — component
// suites render the states, the matrices live in discovery.test.ts.

/** Stable discovery error codes → keys under `settings:lark.picker.error`. */
export type LarkDiscoveryErrorKey =
  | "forbidden"
  | "permission_denied"
  | "unsupported"
  | "unavailable"
  | "rate_limited"
  | "invalid_cursor"
  | "chat_unavailable"
  | "message_unavailable"
  | "installation_inactive"
  | "installation_not_found"
  | "invalid_response"
  | "invalid_request"
  | "generic";

export function larkDiscoveryErrorKey(err: unknown): LarkDiscoveryErrorKey {
  switch (errorCode(err)) {
    case "lark_discovery_forbidden":
      return "forbidden";
    case "lark_discovery_permission_denied":
      return "permission_denied";
    case "lark_discovery_unsupported":
      return "unsupported";
    case "lark_discovery_unavailable":
      return "unavailable";
    case "lark_discovery_rate_limited":
      return "rate_limited";
    case "lark_discovery_invalid_cursor":
      return "invalid_cursor";
    case "lark_discovery_chat_unavailable":
      return "chat_unavailable";
    case "lark_discovery_message_unavailable":
      return "message_unavailable";
    case "lark_installation_inactive":
      return "installation_inactive";
    case "lark_installation_not_found":
      return "installation_not_found";
    case "lark_discovery_invalid_response":
      return "invalid_response";
    case "lark_discovery_invalid_request":
      return "invalid_request";
    default:
      break;
  }
  // A pre-discovery server answers these routes with a bare router 404 and
  // no code. That is the "old server" state, distinct from a coded 404
  // (installation gone / chat unavailable) which is handled above.
  if (err instanceof ApiError && err.status === 404) return "unsupported";
  return "generic";
}

/** Merge chat pages in order, deduplicating by chat_id (first occurrence
 * wins). The provider listing is not an immutable snapshot — a group may
 * move between pages while the bot joins/leaves others. */
export function mergeDiscoveredChats(
  pages: ReadonlyArray<Pick<LarkChatsPage, "items">> | undefined,
): LarkDiscoveredChat[] {
  const seen = new Set<string>();
  const rows: LarkDiscoveredChat[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.chat_id)) continue;
      seen.add(item.chat_id);
      rows.push(item);
    }
  }
  return rows;
}

/** Merge anchor pages in order, deduplicating by message_id. Order is the
 * provider's newest-first; deleted/recalled messages are already omitted
 * server-side. */
export function mergeMessageAnchors(
  pages: ReadonlyArray<Pick<LarkAnchorsPage, "items">> | undefined,
): LarkMessageAnchor[] {
  const seen = new Set<string>();
  const rows: LarkMessageAnchor[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.message_id)) continue;
      seen.add(item.message_id);
      rows.push(item);
    }
  }
  return rows;
}

/** `create_time` is an epoch-millisecond string; anything else is drift and
 * must not become a bogus Date (NaN renders as "Invalid Date"). */
export function anchorTimeMs(createTime: string): number | null {
  if (!/^\d{1,15}$/.test(createTime)) return null;
  const ms = Number(createTime);
  return Number.isFinite(ms) ? ms : null;
}

/** Short non-unique disambiguator shown next to equal-named groups; the full
 * ID is one toggle away in the row itself. */
export function chatIdSuffix(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

// --- Private chat candidates (OL-75 contract, OL-76 frontend) ---

/** Stable candidate/confirmation error codes → keys under
 * `settings:lark.private.error`. */
export type LarkPrivateChatErrorKey =
  | "forbidden"
  | "invocation_denied"
  | "limit_exceeded"
  | "candidate_unavailable"
  | "invalid_request"
  | "installation_inactive"
  | "installation_not_found"
  | "unsupported"
  | "generic";

export function larkPrivateChatErrorKey(err: unknown): LarkPrivateChatErrorKey {
  switch (errorCode(err)) {
    case "lark_discovery_forbidden":
      return "forbidden";
    case "lark_conversation_invocation_denied":
      return "invocation_denied";
    case "lark_conversation_limit_exceeded":
      return "limit_exceeded";
    case "lark_private_chat_candidate_unavailable":
      return "candidate_unavailable";
    case "lark_conversation_invalid_request":
      return "invalid_request";
    case "lark_installation_inactive":
      return "installation_inactive";
    case "lark_installation_not_found":
      return "installation_not_found";
    case "lark_discovery_unsupported":
      return "unsupported";
    default:
      break;
  }
  // Same old-server rule as group discovery: a bare router 404 (no code) is
  // the pre-discovery server, not a coded "installation gone".
  if (err instanceof ApiError && err.status === 404) return "unsupported";
  return "generic";
}

/** Candidate timestamps are RFC3339 strings; drift must not become a bogus
 * Date (NaN renders as "Invalid Date"). */
export function candidateTimeMs(value: string): number | null {
  if (value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Display name only when the contract says one is actually available —
 * identity drift (name_available with an empty name) and unknown statuses
 * degrade to the id_only presentation; a name is never fabricated. */
export function candidateDisplayName(
  candidate: Pick<LarkPrivateChatCandidate, "display_name" | "identity_status">,
): string | null {
  if (candidate.identity_status !== "name_available") return null;
  const name = candidate.display_name.trim();
  return name === "" ? null : candidate.display_name;
}

// --- Conversation draft reconciliation (OL-76 re-review) ---
// The conversation form's draft is "saved grant + explicit local edits". When
// a newer authoritative grant arrives (confirm response via the installations
// cache, WS invalidation, refetch after save), the draft must re-baseline to
// it — a stale draft saved over the new grant would silently drop chats added
// elsewhere and resurrect chats revoked elsewhere.

type ConversationChatLike = { chat_id: string; chat_type: string };

function conversationChatKey(chat: ConversationChatLike): string {
  return `${chat.chat_type}:${chat.chat_id}`;
}

/** Two chat lists carry the same target set (order-independent). Used to
 * skip re-baselining when a refetch only changed the grant's identity. */
export function sameConversationChats(
  a: ReadonlyArray<ConversationChatLike> | null | undefined,
  b: ReadonlyArray<ConversationChatLike> | null | undefined,
): boolean {
  const keys = new Set((a ?? []).map(conversationChatKey));
  const other = (b ?? []).map(conversationChatKey);
  return keys.size === other.length && other.every((k) => keys.has(k));
}

export interface LarkConversationDraftChat {
  chatId: string;
  name: string;
  chat_type: "group" | "p2p";
}

/** Reconcile the form draft with a fresh authoritative grant: the new grant
 * becomes the baseline, then explicit local edit intent is replayed — picks
 * the user added since the baseline stay; chips they removed stay removed;
 * upstream removals win over chats the user merely kept. Draft display names
 * are preserved for surviving chats; new arrivals start nameless (the pickers
 * re-resolve them). */
export function mergeConversationDraft(
  baseline: ReadonlyArray<ConversationChatLike> | null | undefined,
  incoming: ReadonlyArray<ConversationChatLike> | null | undefined,
  draft: ReadonlyArray<LarkConversationDraftChat>,
): LarkConversationDraftChat[] {
  const base = new Set((baseline ?? []).map(conversationChatKey));
  const draftKeys = new Set(draft.map((d) => conversationChatKey({ chat_id: d.chatId, chat_type: d.chat_type })));
  const nameByKey = new Map(
    draft.map((d) => [conversationChatKey({ chat_id: d.chatId, chat_type: d.chat_type }), d.name] as const),
  );
  // Explicit local removals: in the baseline but no longer in the draft.
  const removals = new Set(
    (baseline ?? [])
      .filter((c) => !draftKeys.has(conversationChatKey(c)))
      .map(conversationChatKey),
  );
  const merged: LarkConversationDraftChat[] = [];
  const seen = new Set<string>();
  for (const c of incoming ?? []) {
    const key = conversationChatKey(c);
    if (removals.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      chatId: c.chat_id,
      name: nameByKey.get(key) ?? "",
      chat_type: c.chat_type === "p2p" ? "p2p" : "group",
    });
  }
  // Explicit local additions: in the draft but never in the baseline.
  for (const d of draft) {
    const key = conversationChatKey({ chat_id: d.chatId, chat_type: d.chat_type });
    if (base.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  return merged;
}
