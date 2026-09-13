export interface LarkConversationGrant {
  id: string;
  authorized_by: string;
  scope: "workspace";
  chats: { chat_id: string; chat_type: "group" | "p2p" }[];
}

// --- Target discovery (OL-72 contract, OL-74 frontend) ---
// Wire shapes mirror server/internal/messagedelivery/TARGET-DISCOVERY-CONTRACT.md
// and server/internal/integrations/lark/target-discovery.schema.json. Read-only
// discovery for the group / message-anchor / conversation-grant pickers; it
// never saves or approves a target.

/** What the configured transport can do — describes the transport, not the
 * current provider permission grants (those surface as errors on list calls). */
export interface LarkTargetCapabilities {
  chat_list_supported: boolean;
  message_anchor_list_supported: boolean;
  region: string;
  scope_status: string;
  max_chat_page_size: number;
  max_message_page_size: number;
}

/** One joined group as returned by the discovery list. Identity is
 * (installation_id, chat_id); name/description are NOT unique. */
export interface LarkDiscoveredChat {
  chat_id: string;
  name: string;
  description: string;
  avatar: string;
  external: boolean;
  /** Provider status string ("normal", …). Unknown/new values are retained;
   * they never prove sending is allowed. */
  chat_status: string;
}

export interface LarkChatsPage {
  items: LarkDiscoveredChat[];
  /** false always pairs with next_cursor ""; a short or empty items page does
   * NOT imply completion — keep paging while has_more is true. */
  has_more: boolean;
  /** Opaque signed continuation, valid ~30 min, bound to
   * workspace/installation/caller/query/page-size. Never construct or store
   * it as target identity. */
  next_cursor: string;
}

export interface LarkMessageAnchorSender {
  /** "user" | "app" | "anonymous" | "unknown"; anonymous/unknown carry no id. */
  type: string;
  id?: string;
  id_type?: string;
}

/** One selectable message anchor. `summary` is pre-flattened plain text
 * (never HTML/Markdown); `create_time` is an epoch-millisecond string. */
export interface LarkMessageAnchor {
  message_id: string;
  chat_id: string;
  message_type: string;
  summary: string;
  create_time: string;
  thread_id?: string;
  sender: LarkMessageAnchorSender;
}

export interface LarkAnchorsPage {
  items: LarkMessageAnchor[];
  has_more: boolean;
  next_cursor: string;
}

/** A Lark Bot installation bound to a single Multica agent.
 *
 * Wire shape mirrors `LarkInstallationResponse` in
 * `server/internal/handler/lark.go`. New fields the backend adds in the
 * future MUST default to optional so older desktop builds keep parsing
 * the response — see CLAUDE.md → API Response Compatibility. */
export interface LarkInstallation {
  conversation?: LarkConversationGrant | null;
  id: string;
  workspace_id: string;
  agent_id: string;
  app_id: string;
  tenant_key?: string | null;
  bot_open_id: string;
  installer_user_id: string;
  status: "active" | "revoked" | string;
  /** Which Lark cloud the bot lives on: "feishu" (mainland) or "lark"
   * (international). Auto-detected at install time. Optional so an older
   * desktop build parsing a newer server — or a newer build hitting a
   * server that predates the field — defaults to Feishu in the UI
   * (see CLAUDE.md → API Response Compatibility). */
  region?: "feishu" | "lark" | string;
  installed_at: string;
  created_at: string;
  updated_at: string;
}

export interface ListLarkInstallationsResponse {
  conversation_supported?: boolean;
  installations: LarkInstallation[];
  /** Whether the deployment has the at-rest secret key configured. When
   * false the Bind button must be disabled and the panel renders an
   * empty / "ask the operator to enable Lark" state. */
  configured: boolean;
  /** Whether new installs via the device-flow scan-to-bind path can
   * complete end-to-end — i.e. the device-flow RegistrationService is
   * wired AND the real Lark HTTP APIClient (not the no-op stub) is in
   * place. When false the install entry points are hidden and the
   * panel surfaces a "coming soon" notice. Optional so older desktop
   * builds receiving a server that does not yet emit the field
   * default to `undefined`, treated as not supported. */
  install_supported?: boolean;
}

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
