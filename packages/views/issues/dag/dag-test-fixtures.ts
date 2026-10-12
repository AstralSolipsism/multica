import type { DagDirection } from "@multica/core/issues/stores/view-store";
import { computeDagProjection } from "@multica/core/issues/dag";
import type { DagLayoutResult } from "./dag-layout";

import { graphNode, issueGraph } from "@multica/core/issues/dag/test-fixtures";
export { graphNode, issueGraph } from "@multica/core/issues/dag/test-fixtures";

// Deliberately asymmetric committed geometry: layout itself has separate ELK tests.
export function canvasFixture(
  collapsed: string[] = [],
  direction: DagDirection = "LR",
) {
  const graph = issueGraph(
    [
      graphNode("one", { projectId: "p1" }),
      graphNode("a", { parentIssueId: "one", projectId: "p1", stage: 1 }),
      graphNode("b", { parentIssueId: "one", projectId: "p2", stage: 2 }),
      graphNode("two"),
      graphNode("c", { parentIssueId: "two", stage: 1 }),
      graphNode("d", { parentIssueId: "two", stage: 2 }),
    ],
    [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
    ],
  );
  const projection = computeDagProjection(graph, collapsed);
  const geometry: DagLayoutResult = {
    positions: {},
    groups: {},
    routes: {},
    ports: {},
  };
  for (const node of projection.nodes) {
    const group = projection.groups.find((item) => item.id === node.id);
    const second = node.id === "issue:two" || node.groupId === "issue:two";
    const origin = { x: second ? 660 : 120, y: second ? 180 : 90 };
    const stage = node.issue?.stage ?? 1;
    const position = group
      ? origin
      : {
          x: origin.x + 28 + (direction === "LR" ? (stage - 1) * 260 : 0),
          y: origin.y + 130 + (direction === "TB" ? (stage - 1) * 150 : 0),
        };
    geometry.positions[node.id] = position;
    if (group)
      geometry.groups[node.id] = {
        ...position,
        width: group.collapsed ? 320 : 540,
        height: group.collapsed ? 88 : 440,
        bands: group.collapsed
          ? []
          : [
              {
                stage: 1,
                start: direction === "LR" ? 0 : 88,
                end: direction === "LR" ? 260 : 280,
              },
              {
                stage: 2,
                start: direction === "LR" ? 260 : 280,
                end: direction === "LR" ? 540 : 440,
              },
            ],
        stageConflict: false,
      };
  }
  for (const edge of projection.edges) {
    const source = geometry.positions[edge.source]!;
    const target = geometry.positions[edge.target]!;
    const from = { x: source.x + 248, y: source.y + 40 };
    const to = { x: target.x, y: target.y + 40 };
    geometry.routes[edge.id] = [from, { x: to.x, y: from.y }, to];
    (geometry.ports[edge.source] ??= []).push({
      id: `source:${edge.id}`,
      type: "source",
      x: 248,
      y: 40,
    });
    (geometry.ports[edge.target] ??= []).push({
      id: `target:${edge.id}`,
      type: "target",
      x: 0,
      y: 40,
    });
  }
  return {
    graph,
    projection,
    geometry,
    positions: new Map(Object.entries(geometry.positions)),
    direction,
  };
}
