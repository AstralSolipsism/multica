import { normalizeIssueStatusCategory } from "../config/status";
import type { DagIssue, DagLineInput, DagModelIndex, DagTask } from "./model-index";
import { markDagRedundancy, type DagDetailedDependency } from "./redundancy";
import { dagDependencyClosure } from "./traversal";

export interface DagFrame {
  id: string;
  issue: DagIssue;
  parentId: string | null;
  taskIds: string[];
  frameIds: string[];
  memberIds: string[];
  progress: { completed: number; total: number };
  /** Included only to contain focused descendants; not a closure member. */
  contextOnly: boolean;
}

function frameStructure(members: readonly DagTask[], closure?: ReadonlySet<string>) {
  const frames = new Map<string, DagFrame>();
  for (const member of members) {
    if (member.isFrame) frames.set(member.issue.id, {
      id: member.issue.id, issue: member.issue, parentId: member.parentId,
      taskIds: [], frameIds: [], memberIds: [member.issue.id],
      progress: { completed: 0, total: 0 }, contextOnly: closure ? !closure.has(member.issue.id) : false,
    });
  }
  const tasks: DagTask[] = [];
  for (const member of members) {
    const parent = frames.get(member.parentId ?? "");
    if (parent) (member.isFrame ? parent.frameIds : parent.taskIds).push(member.issue.id);
    if (!member.isFrame) tasks.push(member);
    let ancestor = parent;
    while (ancestor) {
      ancestor.memberIds.push(member.issue.id);
      ancestor.progress.total++;
      if (normalizeIssueStatusCategory(member.issue.statusCategory) === "done") ancestor.progress.completed++;
      ancestor = frames.get(ancestor.parentId ?? "");
    }
  }
  return { frames: [...frames.values()], tasks };
}

export interface DagLineModel extends ReturnType<typeof frameStructure> {
  id: string;
  /** Immutable source identity, used for per-line model/layout memoization. */
  input: DagLineInput;
  dependencies: DagDetailedDependency[];
  upstream: DagLineInput["upstream"];
  downstream: DagLineInput["downstream"];
  project: DagLineInput["project"];
  hasRestrictedContext: boolean;
}

/** All members are present regardless of the overview's completed switch. */
export function computeDagLine(index: DagModelIndex, lineId: string, previous?: DagLineModel): DagLineModel | null {
  const input = index.lineInputs.get(lineId);
  if (!input || !index.forest.children.has(lineId)) return null;
  if (previous?.input === input) return previous;
  return {
    id: lineId, input, ...frameStructure(input.members),
    dependencies: markDagRedundancy(input.members, input.dependencies),
    upstream: input.upstream, downstream: input.downstream, project: input.project,
    hasRestrictedContext: input.hasRestrictedContext,
  };
}

export interface DagFocusGroup extends ReturnType<typeof frameStructure> {
  lineId: string;
}

export interface DagFocusModel {
  issueId: string;
  groups: DagFocusGroup[];
  upstreamIds: ReadonlySet<string>;
  downstreamIds: ReadonlySet<string>;
  dependencies: DagDetailedDependency[];
  hiddenIssueCount: number;
  hasRestrictedContext: boolean;
}

export function computeDagFocus(index: DagModelIndex, issueId: string, showCompleted = false): DagFocusModel {
  const upstream = dagDependencyClosure(index.traversal, [issueId], "upstream");
  const downstream = dagDependencyClosure(index.traversal, [issueId], "downstream");
  const closure = new Set([...upstream, ...downstream]);
  const { hiddenRoots, hiddenSingles, keptCancelled } = index.visibility;
  const visible = (id: string) => showCompleted || keptCancelled.has(id) ||
    (!hiddenRoots.has(index.rootOf.get(id)!) && !hiddenSingles.has(id));
  const included = new Set([...closure].filter(visible));
  const hiddenIssueCount = closure.size - included.size;
  // Add only visible ancestor frames. Hidden tasks never reappear as context.
  for (const id of included) {
    const parent = index.forest.parentOf.get(id);
    if (parent && visible(parent)) included.add(parent);
  }
  const byLine = new Map<string, DagTask[]>();
  const members: DagTask[] = [];
  for (const id of included) {
    const issue = index.issues.get(id)!;
    const parent = index.forest.parentOf.get(id);
    const cancelledBlocking = !showCompleted && keptCancelled.has(id);
    const member: DagTask = {
      issue, parentId: parent && included.has(parent) && (showCompleted || !keptCancelled.has(parent)) ? parent : null,
      isFrame: index.forest.children.has(id) && !cancelledBlocking,
      cancelledBlocking, role: cancelledBlocking ? "context" : issue.role,
    };
    // A cancelled blocker pulled out of a hidden line remains a standalone.
    const root = index.rootOf.get(id)!;
    const groupId = included.has(root) ? root : id;
    const group = byLine.get(groupId) ?? [];
    group.push(member);
    byLine.set(groupId, group);
    members.push(member);
  }
  const edges = index.dependencies.filter((e) => included.has(e.source) && included.has(e.target));
  return {
    issueId,
    groups: [...byLine].map(([lineId, items]) => ({ lineId, ...frameStructure(items, closure) })),
    upstreamIds: new Set([...upstream].filter(visible)),
    downstreamIds: new Set([...downstream].filter(visible)),
    // Focus always includes redundant dependencies for tracing.
    dependencies: markDagRedundancy(members, edges, true),
    hiddenIssueCount, hasRestrictedContext: index.graph.hasRestrictedContext,
  };
}
