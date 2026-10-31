import type { BaselineChapter, EngineeringConfig, IssueGraphNode } from "@multica/core/api";
import type { Member, Project, TimelineEntry } from "@multica/core/types";

export const ENGINEERING_CHAPTERS: readonly BaselineChapter[] = [
  "overview",
  "domain_rules",
  "architecture",
  "exclusions_and_risks",
];

export const RULE_CUT_WARNINGS = new Set(["rule_removed", "rule_shrunk", "rule_deferred"]);

export function engineeringStageTitles(markdown: string | undefined): Map<number, string> {
  const titles = new Map<number, string>();
  if (!markdown) return titles;
  const pattern = /^### \[Stage-(\d+)\][ \t]+(.+)$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const stage = Number(match[1] ?? 0);
    const title = match[2]?.trim();
    if (stage > 0 && title && !titles.has(stage)) titles.set(stage, title);
  }
  return titles;
}

export function selectEngineeringComment(entries: readonly TimelineEntry[]): TimelineEntry | null {
  const comments = entries
    .filter((entry) => entry.type === "comment" && !entry.deleted_at && entry.content?.trim())
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const roots = comments.filter((entry) => !entry.parent_id);
  return roots.find((entry) => {
    const firstLine = entry.content!.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
    return /^需要你定\s*\d+\s*件事/.test(firstLine.trim());
  }) ?? comments[0] ?? null;
}

export interface EngineeringPermissions {
  isAdmin: boolean;
  isDecider: boolean;
  deciderIds: string[];
}

export function engineeringPermissions(
  userId: string | undefined,
  members: readonly Member[],
  project: Project | undefined,
  config: EngineeringConfig,
): EngineeringPermissions {
  const adminIds = members.filter((member) => member.role === "owner" || member.role === "admin").map((member) => member.user_id);
  const deciderIds = new Set(adminIds);
  if (config.deciderMemberIds.length > 0) {
    for (const id of config.deciderMemberIds) deciderIds.add(id);
  } else if (project?.lead_type === "member" && project.lead_id) {
    deciderIds.add(project.lead_id);
  }
  return {
    isAdmin: !!userId && adminIds.includes(userId),
    isDecider: !!userId && deciderIds.has(userId),
    deciderIds: [...deciderIds].sort(),
  };
}

export interface EngineeringStageSummary {
  stage: number | null;
  total: number;
  closed: number;
  blocked: number;
  open: IssueGraphNode[];
}

export function summarizeEngineeringStages(nodes: readonly IssueGraphNode[]): EngineeringStageSummary[] {
  const groups = new Map<number | null, EngineeringStageSummary>();
  for (const node of nodes) {
    const key = node.stage;
    const group = groups.get(key) ?? { stage: key, total: 0, closed: 0, blocked: 0, open: [] };
    group.total += 1;
    if (node.statusCategory === "done" || node.statusCategory === "closed") {
      group.closed += 1;
    } else {
      if (node.status === "blocked") group.blocked += 1;
      group.open.push(node);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.stage === null) return 1;
    if (b.stage === null) return -1;
    return a.stage - b.stage;
  });
}
