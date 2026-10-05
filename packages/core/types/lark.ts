export type { LarkConversationGrant } from "../lark/schema";

// --- Target discovery (OL-72 contract, OL-74 frontend) ---
// Wire shapes mirror server/internal/messagedelivery/TARGET-DISCOVERY-CONTRACT.md
// and server/internal/integrations/lark/target-discovery.schema.json. Read-only
// discovery for the group / message-anchor / conversation-grant pickers; it
// never saves or approves a target.

/** What the configured transport can do — describes the transport, not the
 * current provider permission grants (those surface as errors on list calls). */
export type { LarkTargetCapabilities } from "../lark/schema";

// --- Private chat discovery (OL-75 contract, OL-76 frontend) ---
// Wire shapes mirror server/internal/messagedelivery/PRIVATE-CHAT-DISCOVERY-CONTRACT.md
// and server/internal/integrations/lark/private-chat-discovery.schema.json.
// An observation is NOT consent: it becomes an authorized conversation only
// through an explicit human confirmation.

export type { LarkPrivateChatCandidateSender } from "../lark/schema";

/** One observed private chat awaiting human confirmation. Confirmation
 * identity is the server-issued candidate `id`; conversation identity is
 * (installation_id, chat_id). Never substitute one for the other. */
export type { LarkPrivateChatCandidate } from "../lark/schema";

export type { LarkPrivateChatCandidateList } from "../lark/schema";

/** One joined group as returned by the discovery list. Identity is
 * (installation_id, chat_id); name/description are NOT unique. */
export type { LarkDiscoveredChat } from "../lark/schema";

export type { LarkChatsPage } from "../lark/schema";

export type { LarkMessageAnchorSender } from "../lark/schema";

/** One selectable message anchor. `summary` is pre-flattened plain text
 * (never HTML/Markdown); `create_time` is an epoch-millisecond string. */
export type { LarkMessageAnchor } from "../lark/schema";

export type { LarkAnchorsPage } from "../lark/schema";

/** A Lark Bot installation bound to a single Multica agent.
 *
 * Wire shape mirrors `LarkInstallationResponse` in
 * `server/internal/handler/lark.go`. New fields the backend adds in the
 * future MUST default to optional so older desktop builds keep parsing
 * the response — see CLAUDE.md → API Response Compatibility. */
export type { LarkInstallation } from "../lark/schema";

export type { ListLarkInstallationsResponse } from "../lark/schema";

/** First half of the device-flow install: the server has opened a
 * registration session against accounts.feishu.cn and returned the QR
 * URL. The frontend renders `qr_code_url` as a QR (and as a clickable
 * link fallback) and starts polling `/install/{session_id}/status` at
 * the supplied cadence until success or terminal failure. */
export interface BeginLarkInstallResponse {
  session_id: string;
  qr_code_url: string;
  expires_in_seconds: number;
  poll_interval_seconds: number;
}

/** Status polling result. `status` is the discriminator. */
export interface LarkInstallStatusResponse {
  status: "pending" | "success" | "error" | string;
  /** Populated when status === "success". The frontend invalidates the
   * installations cache so the new row appears in the Settings tab. */
  installation_id?: string;
  /** Stable code on error — switch on this (NOT error_message) to pick
   * the right copy. Common values: "expired", "access_denied",
   * "lark_protocol_error", "bot_info_failed", "installation_conflict",
   * "installer_bind_failed", "internal_error". */
  error_reason?: string;
  /** Human-readable error tail for debugging; the production UI should
   * surface the copy keyed off error_reason and use this only as a
   * diagnostic tooltip. */
  error_message?: string;
}

export interface RedeemLarkBindingTokenResponse {
  workspace_id: string;
  installation_id: string;
  lark_open_id: string;
}
