import {
  DAG_INDEPENDENT_GROUP,
  dagFeatureRepId,
} from "@multica/core/issues/dag";
import { DAG_OVERVIEW_VIEWPORT_KEY } from "@multica/core/issues/stores/dag-preferences";

/** The two DAG levels. `lineId` is the line's root issue id, or
 *  `independent:root` for the standalone-task grid. */
export type DagLevel =
  | { kind: "overview" }
  | { kind: "line"; lineId: string };

export const DAG_OVERVIEW_LEVEL: DagLevel = { kind: "overview" };

export function dagLevelFromLineId(lineId: string | null): DagLevel {
  return lineId ? { kind: "line", lineId } : DAG_OVERVIEW_LEVEL;
}

/** Persisted viewport slots: one for the overview, one per opened line. */
export function dagLevelViewportKey(level: DagLevel): string {
  return level.kind === "overview"
    ? DAG_OVERVIEW_VIEWPORT_KEY
    : `line:${level.lineId}`;
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
