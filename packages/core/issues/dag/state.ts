import type { IssueGraphNode } from "../../api/issue-graph-schemas";
import { normalizeIssueStatusCategory } from "../config/status";

export type DagDependencyState = "satisfied" | "cancelled-blocking" | "advancing" | "blocking";

export function dagIssueFinished(node: Pick<IssueGraphNode, "statusCategory">): boolean {
  const category = normalizeIssueStatusCategory(node.statusCategory);
  return category === "done" || category === "closed";
}

type RunState = { runSummary: Pick<NonNullable<IssueGraphNode["runSummary"]>, "queued" | "dispatched" | "running" | "waitingLocalDirectory"> | null };

export function dagHasActiveRun(node: RunState): boolean {
  const run = node.runSummary;
  return !!run && (run.queued > 0 || run.dispatched > 0 || run.running > 0 || run.waitingLocalDirectory > 0);
}

/** A parent waiter is finished only when its entire subtree has ended. */
export function dagDependencyState(source: Pick<IssueGraphNode, "status" | "statusCategory"> & RunState, targetSubtreeFinished: boolean): DagDependencyState {
  const category = normalizeIssueStatusCategory(source.statusCategory);
  if (category === "done" || targetSubtreeFinished) return "satisfied";
  if (category === "closed") return "cancelled-blocking";
  if ((category === "started" && source.status !== "blocked") || dagHasActiveRun(source)) return "advancing";
  return "blocking";
}

const attention: Record<DagDependencyState, number> = {
  satisfied: 0, advancing: 1, blocking: 2, "cancelled-blocking": 3,
};

export function aggregateDagDependencyState(states: Iterable<DagDependencyState>): DagDependencyState {
  let result: DagDependencyState = "satisfied";
  for (const state of states) if (attention[state] > attention[result]) result = state;
  return result;
}
