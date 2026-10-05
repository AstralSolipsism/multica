import type { IssueViewState } from "./view-store";

type DagPreferences = Pick<
  IssueViewState,
  | "dagDirection"
  | "dagGrouping"
  | "dagExpandedIds"
  | "dagIndependentExpanded"
  | "dagViewport"
>;

/** Legacy collapsed lists cannot be inverted without complete membership. Reset
 * them once by ignoring that key; subsequent snapshots persist expanded IDs only.
 * Keep absent expansions: filtered or stale graphs cannot prove deletion, and
 * inert IDs never synthesize nodes or grant access to hidden issue data. */
export function sanitizeDagPersisted(
  p: Partial<DagPreferences>,
  current: DagPreferences,
): DagPreferences {
  let dagViewport = current.dagViewport;
  if (p.dagViewport !== undefined)
    dagViewport = isDagViewport(p.dagViewport) ? p.dagViewport : null;
  return {
    dagDirection:
      p.dagDirection === "LR" || p.dagDirection === "TB"
        ? p.dagDirection
        : current.dagDirection,
    dagGrouping:
      p.dagGrouping === "project" ||
      p.dagGrouping === "parent" ||
      p.dagGrouping === "none"
        ? p.dagGrouping
        : current.dagGrouping,
    dagIndependentExpanded:
      typeof p.dagIndependentExpanded === "boolean"
        ? p.dagIndependentExpanded
        : current.dagIndependentExpanded,
    dagExpandedIds:
      Array.isArray(p.dagExpandedIds) &&
      p.dagExpandedIds.every((id) => typeof id === "string")
        ? [...new Set(p.dagExpandedIds)]
        : current.dagExpandedIds,
    dagViewport,
  };
}

function isDagViewport(
  value: unknown,
): value is { x: number; y: number; zoom: number } {
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
