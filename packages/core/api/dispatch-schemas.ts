import { z } from "zod";

export const DispatchOutcomeSchema = z.object({
  status: z.enum(["queued", "coalesced", "deferred", "blocked"]),
  reason_code: z.string().min(1),
  target: z.object({ type: z.string(), id: z.string(), name: z.string().optional() }).optional(),
  task_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
}).refine((v) => !["queued", "coalesced"].includes(v.status) || Boolean(v.task_id && v.run_id), {
  message: "An admitted dispatch must identify its task and run",
}).transform((v) => ({
  status: v.status, reasonCode: v.reason_code, target: v.target,
  taskId: v.task_id, runId: v.run_id,
}));
export type DispatchOutcome = z.infer<typeof DispatchOutcomeSchema>;
