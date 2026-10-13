import { z } from "zod";

// Labrastro fork: You Should Know (YSK) response schemas, aligned with the
// OL-188 server implementation (PR #95, docs/engineering/labrastro-ysk-api.md).

export const ISSUE_TIP_TAGS = ["you_should_know", "heads_up"] as const;
export type IssueTipTag = (typeof ISSUE_TIP_TAGS)[number];

export const ISSUE_TIP_STATUSES = ["valid", "overturned", "source_changed"] as const;
export type IssueTipStatus = (typeof ISSUE_TIP_STATUSES)[number];

/** Immutable snapshot saved when a member first opens a tip's side chat. */
export const TipChatSourceSchema = z.object({
  tip_id: z.string().min(1),
  issue_id: z.string().min(1),
  issue_identifier: z.string().min(1),
  source_task_id: z.string().min(1),
  tip: z.object({
    tag: z.enum(ISSUE_TIP_TAGS),
    line: z.string(),
    title: z.string(),
    explanation: z.string(),
    status: z.enum(ISSUE_TIP_STATUSES),
    overturned_reason: z.string().nullable().default(null),
    overturned_by_comment_id: z.string().nullable().default(null),
  }).loose(),
}).loose();
export type TipChatSource = z.infer<typeof TipChatSourceSchema>;

export const TIP_FEEDBACK_VALUES = ["helpful", "not_relevant", "not_understood"] as const;
export type TipFeedback = (typeof TIP_FEEDBACK_VALUES)[number];

/**
 * `user_state` of the current viewer; the server omits the key entirely when
 * they have not acted on the tip, which normalizes to null below.
 */
export const IssueTipUserStateSchema = z.object({
  state: z.enum(["known", "dismissed"]),
  // An unknown feedback degrades to null instead of dropping the whole
  // state — a user who dismissed the tip must not see it again.
  feedback: z.enum(TIP_FEEDBACK_VALUES).nullable().catch(null),
}).loose();
export type IssueTipUserState = z.infer<typeof IssueTipUserStateSchema>;

// A row with an unknown `tag` or `status` is dropped by the row-level catch
// below — an unknown enum must not take down the whole list, but a silently
// defaulted tag/status would misrender the row, so it is discarded instead.
// The same applies to a missing `line`: it is the tip's body, and an
// empty-bodied bubble is worse than a missing row. The server always sends
// `title`/`explanation` as strings ("" when absent); "" normalizes to null.
export const IssueTipSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  issue_id: z.string(),
  issue_identifier: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  /** Null when the tip is anchored on the issue description. */
  anchor_comment_id: z.string().nullable().default(null),
  tag: z.enum(ISSUE_TIP_TAGS),
  line: z.string(),
  title: z.string().default("").transform((title) => title || null),
  explanation: z.string().default("").transform((explanation) => explanation || null),
  status: z.enum(ISSUE_TIP_STATUSES),
  overturned_by_task_id: z.string().nullable().default(null),
  overturned_by_comment_id: z.string().nullable().default(null),
  overturned_reason: z.string().nullable().default(null),
  user_state: IssueTipUserStateSchema
    .nullish()
    .transform((state) => state ?? null)
    .catch(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();
export type IssueTip = z.infer<typeof IssueTipSchema>;

// Row-level degradation: an unreadable tip (unknown enum, missing id or line)
// becomes null and is filtered out, like malformed GLM quota windows.
export const IssueTipListSchema = z.object({
  tips: z.array(IssueTipSchema.nullable().catch(null))
    .transform((tips) => tips.filter((tip) => tip !== null)),
}).loose();
export type IssueTipList = z.infer<typeof IssueTipListSchema>;

/** Body of POST /api/tips/{tipId}/state. */
export const SetTipStateRequestSchema = z.object({
  state: z.enum(["known", "dismissed"]),
  feedback: z.enum(TIP_FEEDBACK_VALUES).nullable().default(null),
});
export type SetTipStateRequest = z.infer<typeof SetTipStateRequestSchema>;

/** True when the tip is valid and the current user has not acted on it. */
export function isTipShownToMe(tip: Pick<IssueTip, "status" | "user_state">): boolean {
  return tip.status === "valid" && tip.user_state === null;
}
