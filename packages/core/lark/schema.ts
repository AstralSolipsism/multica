import { z, type ZodTypeAny } from "zod";

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

export type LarkAnchorsPage = z.infer<typeof LarkAnchorsPageSchema>;

/** One selectable message anchor. `summary` is pre-flattened plain text
 * (never HTML/Markdown); `create_time` is an epoch-millisecond string. */
export type LarkMessageAnchor = z.infer<typeof LarkMessageAnchorSchema>;

export type LarkMessageAnchorSender = LarkMessageAnchor["sender"];

export type LarkChatsPage = z.infer<typeof LarkChatsPageSchema>;

/** One joined group as returned by the discovery list. Identity is
 * (installation_id, chat_id); name/description are NOT unique. */
export type LarkDiscoveredChat = z.infer<typeof LarkDiscoveredChatSchema>;

/** What the configured transport can do — describes the transport, not the
 * current provider permission grants (those surface as errors on list calls). */
export type LarkTargetCapabilities = z.infer<typeof LarkTargetCapabilitiesSchema>;
