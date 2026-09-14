import { z, type ZodTypeAny } from "zod";

const ConversationGrantSchema = z.object({
  id: z.string().uuid(),
  authorized_by: z.string().uuid(),
  scope: z.literal("workspace"),
  chats: z.array(z.object({ chat_id: z.string(), chat_type: z.enum(["group", "p2p"]) })),
});

export const LarkConversationResponseSchema = z.object({ conversation: ConversationGrantSchema.nullable() });

export const LarkInstallationsSchema = z.object({
  installations: z.array(z.object({
    id: z.string(), workspace_id: z.string(), agent_id: z.string(), app_id: z.string(),
    bot_open_id: z.string(), installer_user_id: z.string(), status: z.string(),
    installed_at: z.string(), created_at: z.string(), updated_at: z.string(),
    tenant_key: z.string().nullable().optional(), region: z.string().optional(),
    conversation: ConversationGrantSchema.nullable().optional(),
  })),
  configured: z.boolean(),
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
  // OL-75 additions. Optional: a pre-OL-75 server omits them and the UI must
  // read that as "private chat discovery unsupported" (=== true checks).
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
  chat_status: z.string().optional().default(""),
});

const discoveryPage = <I extends ZodTypeAny>(item: I) =>
  z.object({
    items: z.array(item),
    has_more: z.boolean(),
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
      type: z.string().optional().default("user"),
      id: z.string().optional(),
      id_type: z.string().optional().default("open_id"),
    })
    .optional()
    .default({ type: "user", id_type: "open_id" }),
  display_name: z.string().optional().default(""),
  identity_status: z.string().optional().default("id_only"),
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
