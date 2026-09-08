import { z } from "zod";
import type { CreateIssueRequest, Issue, UpdateIssueRequest } from "../types";
import { IssueSchema, IssueTriggerPreviewSchema } from "./schemas";
import { DispatchOutcomeSchema } from "./dispatch-schemas";

const prerequisiteSchema = z.object({
  issue_id: z.string().min(1),
  status: z.string().min(1),
  status_category: z.string().min(1),
  satisfied: z.boolean(),
  source_edges: z.array(z.string().min(1)).min(1),
  inherited_from: z.array(z.string().min(1)),
  title: z.string().optional(),
  identifier: z.string().optional(),
  descendant_count: z.number().int().nonnegative().optional(),
}).refine((p) => p.satisfied === (p.status_category === "done"), {
  message: "Prerequisite satisfaction must match its current done category",
}).transform((p) => ({
  issueId: p.issue_id,
  status: p.status,
  statusCategory: p.status_category,
  satisfied: p.satisfied,
  sourceEdges: p.source_edges,
  inheritedFrom: p.inherited_from,
  title: p.title,
  identifier: p.identifier,
  descendantCount: p.descendant_count,
}));

// Missing or malformed decision data is unknown, never an empty ready set.
export const DependencyViewSchema = z.object({
  blocked_by: z.array(prerequisiteSchema),
  inherited_blocked_by: z.array(prerequisiteSchema),
  blocking: z.array(prerequisiteSchema),
  unsatisfied: z.array(prerequisiteSchema),
  has_restricted_blockers: z.boolean(),
  dependency_version: z.string().min(1),
}).transform((v) => ({
  blockedBy: v.blocked_by,
  inheritedBlockedBy: v.inherited_blocked_by,
  blocking: v.blocking,
  unsatisfied: v.unsatisfied,
  hasRestrictedBlockers: v.has_restricted_blockers,
  dependencyVersion: v.dependency_version,
}));

export type DependencyView = z.infer<typeof DependencyViewSchema>;
export type IssuePrerequisite = z.infer<typeof prerequisiteSchema>;
export type IssueWithDependencies = Issue & { dependencies: DependencyView | null };

export const IssueWithDependenciesSchema = IssueSchema.extend({
  dependencies: DependencyViewSchema.nullable().catch(null),
});

export const IssueBatchUpdateSchema = z.object({
  updated: z.number().int().nonnegative(),
  // Older servers only report the total. Incomplete item diagnostics stay
  // unknown while retaining that authoritative total.
  results: z.array(z.object({
    dispatch: DispatchOutcomeSchema.nullable().catch(null),
    issue_id: z.string().min(1),
    updated: z.boolean(),
    reason_code: z.string().optional(),
    error: z.string().optional(),
    dependencies: DependencyViewSchema.nullable().catch(null),
  }).transform((item) => ({
    dispatch: item.dispatch,
    issueId: item.issue_id,
    updated: item.updated,
    reasonCode: item.reason_code,
    error: item.error,
    dependencies: item.dependencies,
  }))).nullable().catch(null),
});
export type IssueBatchUpdateResult = z.infer<typeof IssueBatchUpdateSchema>;

export type CreateIssueWithDependenciesRequest = CreateIssueRequest & DependencyMutationFields;
export type UpdateIssueWithDependenciesRequest = UpdateIssueRequest & DependencyMutationFields;

export function dependencyReadiness(view: DependencyView | null | undefined): "unknown" | "blocked" | "ready" {
  if (!view) return "unknown";
  if (view.hasRestrictedBlockers === true || view.unsatisfied.length > 0
    || [...view.blockedBy, ...view.inheritedBlockedBy].some((p) => p.satisfied !== true)) {
    return "blocked";
  }
  return "ready";
}

export type DependencyOverride = { requestId: string; challenge: string };
export type DependencyMutationFields = {
  blockedBy?: string[];
  expectedDependencyVersion?: string;
  dependencyOverride?: DependencyOverride;
};

const confirmationSchema = z.object({
  request_id: z.string().min(1), challenge: z.string().min(1), expires_at: z.iso.datetime(),
}).transform((v) => ({ requestId: v.request_id, challenge: v.challenge, expiresAt: v.expires_at }));

const dependencyPreviewItemSchema = z.object({
  issue_id: z.string().min(1), reason_code: z.string().min(1),
  dependencies: DependencyViewSchema.nullable().catch(null),
  confirmation: confirmationSchema.nullable().catch(null),
}).transform((v) => ({
  issueId: v.issue_id, reasonCode: v.reason_code, dependencies: v.dependencies, confirmation: v.confirmation,
}));
export type IssueDependencyPreview = z.infer<typeof dependencyPreviewItemSchema>;
export const DependencyTriggerPreviewSchema = IssueTriggerPreviewSchema.extend({
  // Missing diagnostics are unknown, never proof that prerequisites are ready.
  blocked: z.array(dependencyPreviewItemSchema).nullable().catch(null),
});

export function dependencyMutationToWire(data: (CreateIssueRequest | UpdateIssueRequest) & DependencyMutationFields) {
  const { blockedBy, expectedDependencyVersion, dependencyOverride, ...issue } = data;
  return {
    ...issue, blocked_by: blockedBy, expected_dependency_version: expectedDependencyVersion,
    dependency_override: dependencyOverride ? { request_id: dependencyOverride.requestId, challenge: dependencyOverride.challenge } : undefined,
  };
}
