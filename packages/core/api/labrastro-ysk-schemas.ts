import { z } from "zod";

// Labrastro fork: You Should Know (YSK) response schemas (OL-187 §13 F/G).
// The server implementation (OL-188) is not merged yet; these shapes follow
// the OL-187 contract and are reconciled in the 6/6 integration step.

export const ISSUE_TIP_TAGS = ["you_should_know", "heads_up"] as const;
export type IssueTipTag = (typeof ISSUE_TIP_TAGS)[number];

export const ISSUE_TIP_STATUSES = ["valid", "overturned", "source_changed"] as const;
export type IssueTipStatus = (typeof ISSUE_TIP_STATUSES)[number];

export const TIP_FEEDBACK_VALUES = ["helpful", "not_relevant", "not_understood"] as const;
export type TipFeedback = (typeof TIP_FEEDBACK_VALUES)[number];

/** `my_state` of the current user; null when they have not acted on the tip. */
export const IssueTipMyStateSchema = z.object({
  state: z.enum(["known", "dismissed"]),
  feedback: z.enum(TIP_FEEDBACK_VALUES).nullable().default(null),
}).loose();
export type IssueTipMyState = z.infer<typeof IssueTipMyStateSchema>;

// A row with an unknown `tag` or `status` is dropped by the row-level catch
// below — an unknown enum must not take down the whole list, but a silently
// defaulted tag/status would misrender the row, so it is discarded instead.
export const IssueTipSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  /** Null when the tip is anchored on the issue description. */
  anchor_comment_id: z.string().nullable().default(null),
  tag: z.enum(ISSUE_TIP_TAGS),
  line: z.string().default(""),
  title: z.string().nullable().default(null),
  explanation: z.string().nullable().default(null),
  status: z.enum(ISSUE_TIP_STATUSES),
  overturned_by_task_id: z.string().nullable().default(null),
  overturned_by_comment_id: z.string().nullable().default(null),
  overturn_reason: z.string().nullable().default(null),
  my_state: IssueTipMyStateSchema.nullable().catch(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();
export type IssueTip = z.infer<typeof IssueTipSchema>;

// Row-level degradation: an unreadable tip (unknown enum, missing id) becomes
// null and is filtered out, like malformed GLM quota windows.
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
export function isTipShownToMe(tip: Pick<IssueTip, "status" | "my_state">): boolean {
  return tip.status === "valid" && tip.my_state === null;
}
