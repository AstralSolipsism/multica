import { z } from "zod";

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
