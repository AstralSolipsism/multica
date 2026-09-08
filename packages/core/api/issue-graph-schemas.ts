import { z } from "zod";
import type { IssueTableQuerySpec } from "../types";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });

const dependencySummary = z.object({
  visible_unsatisfied_count: count,
  has_restricted_blockers: z.boolean(),
  dependency_version: id,
}).transform((v) => ({
  visibleUnsatisfiedCount: v.visible_unsatisfied_count,
  hasRestrictedBlockers: v.has_restricted_blockers,
  dependencyVersion: v.dependency_version,
}));

const runSummary = z.object({
  queued: count,
  dispatched: count,
  running: count,
  waiting_local_directory: count,
  captured_at: timestamp,
}).transform((v) => ({
  queued: v.queued,
  dispatched: v.dispatched,
  running: v.running,
  waitingLocalDirectory: v.waiting_local_directory,
  capturedAt: v.captured_at,
}));

const node = z.object({
  id,
  identifier: id,
  title: z.string(),
  status: id,
  status_category: id,
  revision: count,
  parent_issue_id: id.nullable(),
  has_restricted_parent: z.boolean(),
  project_id: id.nullable(),
  stage: z.number().int().positive().nullable(),
  priority: z.string(),
  assignee: z.object({ id, type: id }).nullable(),
  role: z.enum(["match", "context"]),
  // Unknown summaries preserve usable topology, but cannot imply ready/idle.
  run_summary: runSummary.nullable().catch(null),
  dependency_summary: dependencySummary.nullable().catch(null),
}).transform((v) => ({
  id: v.id,
  identifier: v.identifier,
  title: v.title,
  status: v.status,
  statusCategory: v.status_category,
  revision: v.revision,
  parentIssueId: v.parent_issue_id,
  hasRestrictedParent: v.has_restricted_parent,
  projectId: v.project_id,
  stage: v.stage,
  priority: v.priority,
  assignee: v.assignee,
  role: v.role,
  runSummary: v.run_summary,
  dependencySummary: v.dependency_summary,
}));

export const IssueGraphSchema = z.object({
  schema_version: z.literal(1),
  snapshot_id: id,
  topology_id: id,
  captured_at: timestamp,
  complete: z.literal(true),
  scope: z.object({ type: z.enum(["workspace", "project"]), project_id: id.nullable() }),
  focus_issue_id: id.nullable(),
  matched_count: count,
  context_count: count,
  nodes: z.array(node),
  edges: z.array(z.object({ source_edge_id: id, source: id, target: id, type: z.literal("blocked_by") })),
  projects: z.array(z.object({ id, title: z.string() })),
  has_restricted_context: z.boolean(),
}).superRefine((g, ctx) => {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const projects = new Set(g.projects.map((p) => p.id));
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (nodes.size !== g.nodes.length || projects.size !== g.projects.length) invalid("Duplicate graph identity");
  if (g.nodes.filter((n) => n.role === "match").length !== g.matched_count
    || g.nodes.filter((n) => n.role === "context").length !== g.context_count) invalid("Graph counts disagree with nodes");
  if ((g.scope.type === "project") !== (g.scope.project_id !== null)) invalid("Invalid graph scope");
  if (g.focus_issue_id !== null && !nodes.has(g.focus_issue_id)) invalid("Missing graph focus");
  const checked = new Set<string>();
  for (const n of g.nodes) {
    if (n.parentIssueId !== null && !nodes.has(n.parentIssueId)) invalid("Missing parent context");
    if (n.hasRestrictedParent === true && n.parentIssueId !== null) invalid("Restricted parent disclosed");
    if (n.projectId !== null && !projects.has(n.projectId)) invalid("Missing project context");
    const path = new Set<string>();
    let current: string | null = n.id;
    while (current !== null && !checked.has(current)) {
      if (path.has(current)) { invalid("Cyclic parent context"); break; }
      path.add(current);
      current = nodes.get(current)?.parentIssueId ?? null;
    }
    for (const item of path) checked.add(item);
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (edgeIds.has(e.source_edge_id)) invalid("Duplicate source edge");
    edgeIds.add(e.source_edge_id);
    if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) invalid("Invalid dependency endpoints");
  }
}).transform((g) => ({
  schemaVersion: g.schema_version,
  snapshotId: g.snapshot_id,
  topologyId: g.topology_id,
  capturedAt: g.captured_at,
  complete: g.complete,
  scope: { type: g.scope.type, projectId: g.scope.project_id },
  focusIssueId: g.focus_issue_id,
  matchedCount: g.matched_count,
  contextCount: g.context_count,
  nodes: g.nodes,
  edges: g.edges.map((e) => ({ sourceEdgeId: e.source_edge_id, source: e.source, target: e.target, type: e.type })),
  projects: g.projects,
  hasRestrictedContext: g.has_restricted_context,
}));

export type IssueGraph = z.infer<typeof IssueGraphSchema>;
export type IssueGraphNode = IssueGraph["nodes"][number];
export interface IssueGraphRequest {
  query: IssueTableQuerySpec;
  focusIssueId?: string;
}

export function issueGraphReadiness(summary: IssueGraphNode["dependencySummary"] | undefined): "unknown" | "blocked" | "ready" {
  if (!summary) return "unknown";
  return summary.hasRestrictedBlockers === true || summary.visibleUnsatisfiedCount > 0 ? "blocked" : "ready";
}
