// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { toFlowNodes, selectFlowNodes, toFlowEdges } from "./dag-flow";
import { canvasFixture } from "./dag-test-fixtures";

function nodeInput() {
  return {
    ...canvasFixture(),
    projectNames: new Map([
      ["p1", "Project One"],
      ["p2", "Project Two"],
    ]),
    statusColorOf: () => "#123456",
    measurements: new Map([["a", { width: 248, height: 116 }]]),
    selectedNodeId: "b",
    focusSet: new Set(["a", "b"]),
    selectionContext: {
      activeGroups: new Set(["issue:one"]),
      stages: new Map([["issue:one", 2]]),
    },
    toggle: vi.fn(),
    openIssue: vi.fn(),
    onFocusGroup: vi.fn(),
  };
}

describe("toFlowNodes", () => {
  it("maps absolute children to container coordinates and preserves geometry, ports and callbacks", () => {
    const input = nodeInput();
    const before = JSON.stringify(input.geometry);
    const baseNodes = toFlowNodes(input);
    const nodes = selectFlowNodes(baseNodes, input);
    const a = nodes.find((node) => node.id === "a")!;
    expect(a).toMatchObject({
      type: "dagNode",
      parentId: "issue:one",
      position: { x: 28, y: 130 },
      width: 248,
      height: 116,
      measured: { width: 248, height: 116 },
      selected: false,
      draggable: false,
      connectable: false,
      zIndex: 2,
      data: {
        projectTitle: null,
        statusColor: "#123456",
        showStage: false,
        focused: true,
        dimmed: false,
      },
    });
    expect(a.data.ports).toBe(input.geometry.ports.a);
    expect(nodes.find((node) => node.id === "b")).toMatchObject({
      selected: true,
      data: { projectTitle: "Project Two", focused: true },
    });
    expect(nodes.find((node) => node.id === "d")).toMatchObject({
      selected: false,
      data: { focused: false, dimmed: false, ports: expect.any(Array) },
    });
    expect(nodes.find((node) => node.id === "issue:one")).toMatchObject({
      type: "dagGroup",
      position: { x: 120, y: 90 },
      width: 540,
      height: 440,
      zIndex: 0,
      data: {
        projectTitle: "Project One",
        activeStage: 2,
        focused: true,
        direction: "LR",
        onToggle: input.toggle,
        onOpen: input.openIssue,
        onFocus: input.onFocusGroup,
      },
    });
    expect(nodes.find((node) => node.id === "d")).toBe(
      baseNodes.find((node) => node.id === "d"),
    );
    expect(JSON.stringify(input.geometry)).toBe(before);
  });

  it("omits unpositioned nodes and groups without bounds; exposes a stage when no band explains it", () => {
    const input = nodeInput();
    input.positions.delete("a");
    delete input.geometry.groups["issue:two"];
    input.geometry.groups["issue:one"]!.bands = [];
    delete input.geometry.ports.b;
    const nodes = toFlowNodes(input);
    expect(nodes.map((node) => node.id)).not.toContain("a");
    expect(nodes.map((node) => node.id)).not.toContain("issue:two");
    expect(nodes.find((node) => node.id === "b")!.data).toMatchObject({
      showStage: true,
      ports: [],
    });
  });
});

describe("toFlowEdges", () => {
  function input(collapsed: string[] = []) {
    return {
      ...canvasFixture(collapsed),
      selectedNodeId: "b",
      selectedEdgeId: null,
      focusSet: null,
      selectEdge: vi.fn(),
    };
  }

  it("highlights only direct incident edges on selection and preserves real routes and handle ids", () => {
    const args = input();
    const edges = toFlowEdges(args);
    expect(
      edges
        .filter((edge) => edge.data!.focused)
        .map((edge) => edge.data!.model.sourceEdgeIds),
    ).toEqual([["a-b"], ["b-c"]]);
    for (const edge of edges) {
      expect(edge.data!.route).toBe(args.geometry.routes[edge.id]);
      expect(edge).toMatchObject({
        type: "dagEdge",
        sourceHandle: `source:${edge.id}`,
        targetHandle: `target:${edge.id}`,
        zIndex: 1,
      });
      expect(edge.data!.onSelect).toBe(args.selectEdge);
      expect(edge.data!.aggregate).toBe(false);
    }
  });

  it("requires both endpoints in an explicit neighborhood, independently highlights a selected edge", () => {
    const args = input();
    const selectedEdgeId = args.projection.edges.find(
      (edge) => edge.source === "c",
    )!.id;
    const edges = toFlowEdges({
      ...args,
      selectedEdgeId,
      focusSet: new Set(["a", "c"]),
    });
    expect(
      edges
        .filter((edge) => edge.data!.focused)
        .map((edge) => edge.data!.model.sourceEdgeIds),
    ).toEqual([["a-c"]]);
    expect(edges.find((edge) => edge.id === selectedEdgeId)).toMatchObject({
      selected: true,
      data: { focused: false },
      markerEnd: { color: "var(--brand)" },
    });
    expect(
      edges.find((edge) => edge.data!.model.sourceEdgeIds[0] === "a-b")!
        .markerEnd,
    ).toMatchObject({ color: "var(--muted-foreground)" });
  });

  it("marks one or several original pairs between two folded groups as aggregate", () => {
    const args = input(["issue:one", "issue:two"]);
    expect(toFlowEdges(args)[0]!.data).toMatchObject({
      aggregate: true,
      model: { sourceEdgeIds: ["a-c", "b-c"] },
    });
    const edge = args.projection.edges[0]!;
    edge.sourceEdgeIds = ["a-c"];
    edge.sources = [{ edgeId: "a-c", source: "a", target: "c" }];
    expect(toFlowEdges(args)[0]!.data!.aggregate).toBe(true);
  });

  it.each([
    { side: "source", folded: "issue:one", source: "issue:one", target: "c" },
    { side: "target", folded: "issue:two", source: "a", target: "issue:two" },
  ])(
    "marks a single original pair with only the $side folded as aggregate",
    ({ folded, source, target }) => {
      const args = input([folded]);
      const edge = args.projection.edges.find((e) => e.source === source && e.target === target)!;
      // Keep one original pair so only the folded endpoint can make this aggregate.
      edge.sourceEdgeIds = ["a-c"];
      edge.sources = [{ edgeId: "a-c", source: "a", target: "c" }];
      const mapped = toFlowEdges(args).find((e) => e.id === edge.id)!;
      expect(mapped).toMatchObject({ source, target, data: { aggregate: true } });
      expect(mapped.data!.model.sourceEdgeIds).toHaveLength(1);
      expect(mapped.data!.model.sources).toHaveLength(1);
    },
  );

  it("omits unrouted edges and missing endpoints rather than inventing geometry", () => {
    const args = input();
    delete args.geometry.routes[args.projection.edges[0]!.id];
    args.positions.delete("c");
    expect(toFlowEdges(args)).toEqual([]);
  });
});
