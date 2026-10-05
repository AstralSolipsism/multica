import { z, type ZodTypeAny } from "zod";

const ConversationGrantSchema = z.object({
  id: z.string().uuid(),
  authorized_by: z.string().uuid(),
  scope: z.literal("workspace"),
  chats: z.array(z.object({ chat_id: z.string(), chat_type: z.enum(["group", "p2p"]) })),
});

export const LarkConversationResponseSchema = z.object({ conversation: ConversationGrantSchema.nullable() });

// List reads preserve installations even when a newer server adds a grant
// scope or chat kind. Unreadable grants are never equivalent to no grant.
const ConversationGrantReadSchema = z.object({
  id: z.string(),
  authorized_by: z.string(),
  /** Read fallback only; forms must not replace an unreadable grant. */
  scope: z.enum(["workspace", "unreadable"]).catch("unreadable"),
  chats: z.array(z.object({
    chat_id: z.string(),
    chat_type: z.enum(["group", "p2p", "unreadable"]).catch("unreadable"),
  }).catch({ chat_id: "", chat_type: "unreadable" })),
}).catch({ id: "", authorized_by: "", scope: "unreadable", chats: [] });

// Saving replaces the whole chat set. The server omits conversation when
// there is no grant; null has the same meaning. Callers gate writes separately
// on conversation_supported and the installation query's availability.
export function isEditableLarkConversation(grant: unknown): boolean {
  return grant == null || ConversationGrantSchema.safeParse(grant).success;
}

export const LarkInstallationsSchema = z.object({
  installations: z.array(z.object({
    id: z.string(), workspace_id: z.string(), agent_id: z.string(), app_id: z.string(),
    bot_open_id: z.string(), installer_user_id: z.string(), status: z.string(),
    installed_at: z.string(), created_at: z.string(), updated_at: z.string(),
    tenant_key: z.string().nullable().optional(),
    /** Which Lark cloud the bot lives on: "feishu" (mainland) or "lark"
     * (international). Auto-detected at install time. Optional so an older
     * desktop build parsing a newer server — or a newer build hitting a
     * server that predates the field — defaults to Feishu in the UI
     * (see CLAUDE.md → API Response Compatibility). */
    region: z.string().optional(),
    conversation: ConversationGrantReadSchema.nullable().optional(),
  })),
  /** Whether the deployment has the at-rest secret key configured. When
   * false the Bind button must be disabled and the panel renders an
   * empty / "ask the operator to enable Lark" state. */
  configured: z.boolean(),
  /** Whether new installs via the device-flow scan-to-bind path can
   * complete end-to-end — i.e. the device-flow RegistrationService is
   * wired AND the real Lark HTTP APIClient (not the no-op stub) is in
   * place. When false the install entry points are hidden and the
   * panel surfaces a "coming soon" notice. Optional so older desktop
   * builds receiving a server that does not yet emit the field
   * default to `undefined`, treated as not supported. */
  install_supported: z.boolean().optional(),
  conversation_supported: z.boolean().optional(),
});

// Target discovery (OL-72 wire contract, see
// server/internal/messagedelivery/TARGET-DISCOVERY-CONTRACT.md). Lenient on
// the descriptive fields so contract drift degrades a row instead of failing
// the page; the identity fields stay required — a row without them is not a
// selectable target.

export const LarkTargetCapabilitiesSchema = z.object({
  chat_list_supported: z.boolean(),
  message_anchor_list_supported: z.boolean(),
  region: z.string(),
  scope_status: z.string(),
  max_chat_page_size: z.number(),
  max_message_page_size: z.number(),
  /** OL-75 private-chat discovery. Optional: a server predating OL-75 omits
   * them, which the UI must read as "not supported" (=== true checks). */
  private_chat_candidates_supported: z.boolean().optional(),
  private_chat_identity_lookup_supported: z.boolean().optional(),
  max_private_chat_candidates: z.number().optional(),
  private_chat_candidate_retention_seconds: z.number().optional(),
});

const LarkDiscoveredChatSchema = z.object({
  chat_id: z.string(),
  name: z.string().optional().default(""),
  description: z.string().optional().default(""),
  avatar: z.string().optional().default(""),
  external: z.boolean().optional().default(false),
  /** Provider status string ("normal", …). Unknown/new values are retained;
   * they never prove sending is allowed. */
  chat_status: z.string().optional().default(""),
});

const discoveryPage = <I extends ZodTypeAny>(item: I) =>
  z.object({
    items: z.array(item),
    /** false always pairs with next_cursor ""; a short or empty items page does
     * NOT imply completion — keep paging while has_more is true. */
    has_more: z.boolean(),
    /** Opaque signed continuation, valid ~30 min, bound to
     * workspace/installation/caller/query/page-size. Never construct or store
     * it as target identity. */
    next_cursor: z.string(),
  });

export const LarkChatsPageSchema = discoveryPage(LarkDiscoveredChatSchema);

const LarkMessageAnchorSchema = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  message_type: z.string().optional().default(""),
  summary: z.string(),
  create_time: z.string(),
  thread_id: z.string().optional(),
  sender: z.object({
    /** "user" | "app" | "anonymous" | "unknown"; anonymous/unknown carry no id. */
    type: z.string(),
    id: z.string().optional(),
    id_type: z.string().optional(),
  }),
});

export const LarkAnchorsPageSchema = discoveryPage(LarkMessageAnchorSchema);

// Private chat discovery (OL-75 wire contract, see
// server/internal/messagedelivery/PRIVATE-CHAT-DISCOVERY-CONTRACT.md). The
// candidate UUID and chat_id stay required — a row without them can neither
// be confirmed nor identified; descriptive fields default so drift degrades
// a row into its id_only / pending state instead of failing the list.

const LarkPrivateChatCandidateSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  chat_type: z.string().optional().default("p2p"),
  sender: z
    .object({
      /** "user" for real candidates; anonymous/app senders never qualify. */
      type: z.string().optional().default("user"),
      /** App-scoped open ID (ou_…). Identity evidence only — never a platform
       * member, never a selectable target by itself. */
      id: z.string().optional(),
      id_type: z.string().optional().default("open_id"),
    })
    .optional()
    .default({ type: "user", id_type: "open_id" }),
  /** Plain-text contact name, "" when the provider did not return one.
   * Never fabricated client-side. */
  display_name: z.string().optional().default(""),
  /** "name_available" | "id_only"; unknown values must be treated as id_only. */
  identity_status: z.string().optional().default("id_only"),
  /** "pending" | "authorized" — saved consent state, not provider
   * reachability; unknown values must be treated as pending. */
  authorization_status: z.string().optional().default("pending"),
  first_seen_at: z.string().optional().default(""),
  last_seen_at: z.string().optional().default(""),
  expires_at: z.string().optional().default(""),
});

export const LarkPrivateChatCandidatesSchema = z.object({
  items: z.array(LarkPrivateChatCandidateSchema),
  max_candidates: z.number().optional().default(50),
  retention_seconds: z.number().optional().default(604800),
});

export type ListLarkInstallationsResponse = z.infer<typeof LarkInstallationsSchema>;

/** A Lark Bot installation bound to a single Multica agent.
 *
 * Wire shape mirrors `LarkInstallationResponse` in
 * `server/internal/handler/lark.go`. New fields the backend adds in the
 * future MUST default to optional so older desktop builds keep parsing
 * the response — see CLAUDE.md → API Response Compatibility. */
export type LarkInstallation = ListLarkInstallationsResponse["installations"][number];

export type LarkAnchorsPage = z.infer<typeof LarkAnchorsPageSchema>;

/** One selectable message anchor. `summary` is pre-flattened plain text
 * (never HTML/Markdown); `create_time` is an epoch-millisecond string. */
export type LarkMessageAnchor = z.infer<typeof LarkMessageAnchorSchema>;

export type LarkMessageAnchorSender = LarkMessageAnchor["sender"];

export type LarkChatsPage = z.infer<typeof LarkChatsPageSchema>;

/** One joined group as returned by the discovery list. Identity is
 * (installation_id, chat_id); name/description are NOT unique. */
export type LarkDiscoveredChat = z.infer<typeof LarkDiscoveredChatSchema>;

export type LarkPrivateChatCandidateList = z.infer<typeof LarkPrivateChatCandidatesSchema>;

/** One observed private chat awaiting human confirmation. Confirmation
 * identity is the server-issued candidate `id`; conversation identity is
 * (installation_id, chat_id). Never substitute one for the other. */
export type LarkPrivateChatCandidate = z.infer<typeof LarkPrivateChatCandidateSchema>;

export type LarkPrivateChatCandidateSender = LarkPrivateChatCandidate["sender"];

/** What the configured transport can do — describes the transport, not the
 * current provider permission grants (those surface as errors on list calls). */
export type LarkTargetCapabilities = z.infer<typeof LarkTargetCapabilitiesSchema>;

export type LarkConversationGrant = z.infer<typeof ConversationGrantReadSchema>;
