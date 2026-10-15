import type { DagViewport, IssueViewState } from "./view-store";

type DagPreferences = Pick<
  IssueViewState,
  | "dagGrouping"
  | "dagShowCompleted"
  | "dagShowSatisfiedDependencies"
  | "dagLineId"
  | "dagFocusIssueId"
  | "dagOverviewPinned"
  | "dagViewports"
>;

/** Viewport key for the DAG overview level; line levels use `line:<rootId>`. */
export const DAG_OVERVIEW_VIEWPORT_KEY = "overview";

/** Stage 9 dropped fold state, direction and the single shared viewport.
 * Those keys are stripped by the caller before this runs; the one legacy
 * value worth keeping is `dagViewport`, which becomes the overview entry. */
export function sanitizeDagPersisted(
  p: Partial<DagPreferences> & { dagViewport?: unknown },
  current: DagPreferences,
): DagPreferences {
  let dagViewports = current.dagViewports;
  if (p.dagViewports !== undefined) {
    if (p.dagViewports && typeof p.dagViewports === "object" && !Array.isArray(p.dagViewports)) {
      const entries = Object.entries(p.dagViewports as Record<string, unknown>)
        .filter((entry): entry is [string, DagViewport] => isDagViewport(entry[1]));
      dagViewports = Object.fromEntries(entries);
    } else dagViewports = {};
  } else if (isDagViewport(p.dagViewport)) {
    dagViewports = { [DAG_OVERVIEW_VIEWPORT_KEY]: p.dagViewport };
  }
  return {
    dagGrouping:
      p.dagGrouping === "project" ||
      p.dagGrouping === "parent" ||
      p.dagGrouping === "none"
        ? p.dagGrouping
        : current.dagGrouping,
    dagShowCompleted:
      typeof p.dagShowCompleted === "boolean"
        ? p.dagShowCompleted
        : current.dagShowCompleted,
    dagShowSatisfiedDependencies:
      typeof p.dagShowSatisfiedDependencies === "boolean"
        ? p.dagShowSatisfiedDependencies
        : current.dagShowSatisfiedDependencies,
    dagLineId:
      typeof p.dagLineId === "string" || p.dagLineId === null
        ? p.dagLineId
        : current.dagLineId,
    dagFocusIssueId:
      typeof p.dagFocusIssueId === "string" || p.dagFocusIssueId === null
        ? p.dagFocusIssueId
        : current.dagFocusIssueId,
    dagOverviewPinned:
      typeof p.dagOverviewPinned === "boolean"
        ? p.dagOverviewPinned
        : current.dagOverviewPinned,
    dagViewports,
  };
}

function isDagViewport(value: unknown): value is DagViewport {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return (
    typeof viewport.x === "number" &&
    Number.isFinite(viewport.x) &&
    typeof viewport.y === "number" &&
    Number.isFinite(viewport.y) &&
    typeof viewport.zoom === "number" &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom >= 0.08 &&
    viewport.zoom <= 2
  );
}
