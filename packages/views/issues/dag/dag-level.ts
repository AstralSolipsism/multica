import {
  DAG_INDEPENDENT_GROUP,
  dagFeatureRepId,
} from "@multica/core/issues/dag";
import type { DagScenePlan } from "./dag-scene";
import { DAG_OVERVIEW_VIEWPORT_KEY } from "@multica/core/issues/stores/dag-preferences";

/** The overview, line and focus levels. `lineId` is the line's root issue id, or
 *  `independent:root` for the standalone-task grid. */
export type DagLevel =
  | { kind: "overview" }
  | { kind: "line"; lineId: string }
  | { kind: "focus"; issueId: string };

export const DAG_OVERVIEW_LEVEL: DagLevel = { kind: "overview" };

export function dagLevelFromLineId(lineId: string | null): DagLevel {
  return lineId ? { kind: "line", lineId } : DAG_OVERVIEW_LEVEL;
}

/** An authorized containing line, never a made-up line for a standalone task. */
export function dagContainingLineId(
  issueId: string,
  issues: ReadonlyMap<string, { parentIssueId: string | null }>,
): string | null {
  if (!issues.has(issueId)) return null;
  const seen = new Set<string>();
  let root = issueId;
  while (!seen.has(root)) {
    seen.add(root);
    const parent = issues.get(root)?.parentIssueId;
    if (!parent || !issues.has(parent))
      return [...issues.values()].some((issue) => issue.parentIssueId === root) ? root : null;
    root = parent;
  }
  return null;
}

/** Persisted viewport slots: overview, opened lines and focused issues. */
export function dagLevelViewportKey(level: DagLevel): string {
  return level.kind === "overview"
    ? DAG_OVERVIEW_VIEWPORT_KEY
    : level.kind === "focus" ? `focus:${level.issueId}` : `line:${level.lineId}`;
}

/** Whether a line id addresses the standalone-task grid rather than a real
 *  task line — it needs the overview model and the grid layout input. */
export function dagLevelIsIndependent(level: DagLevel): boolean {
  return level.kind === "line" && level.lineId === DAG_INDEPENDENT_GROUP;
}

/** The overview card representing a line (what "back to overview" selects). */
export function dagOverviewCardIdForLine(lineId: string): string {
  return lineId === DAG_INDEPENDENT_GROUP
    ? DAG_INDEPENDENT_GROUP
    : dagFeatureRepId(lineId);
}

/** Single-line auto-entry fires only until the user deliberately returns to
 *  the overview; `dagOverviewPinned` records that choice across reloads. */
export function dagAutoEnterLineId(params: {
  pinned: boolean;
  autoEnterLineId: string | null;
}): string | null {
  return params.pinned ? null : params.autoEnterLineId;
}

export type DagExternalJump =
  | { kind: "line"; lineId: string }
  | { kind: "overview"; cardId: string };

/** External side-card click: lines are entered in place; a standalone task
 *  lives only on the overview, so the jump goes there and locates its card. */
export function dagExternalJumpTarget(group: {
  id: string;
  kind: "line" | "issue";
}): DagExternalJump {
  return group.kind === "line"
    ? { kind: "line", lineId: group.id }
    : { kind: "overview", cardId: group.id };
}

/** Painted identity, including while the requested level is still loading. */
export function dagLevelFromPlan(plan: DagScenePlan): DagLevel {
  if (plan.input.kind === "focus") return { kind: "focus", issueId: plan.input.id };
  return plan.input.kind === "overview" ? DAG_OVERVIEW_LEVEL : { kind: "line", lineId: plan.input.id };
}
