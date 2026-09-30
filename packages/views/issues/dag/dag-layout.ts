import type { ElkNode, ElkPort, ElkExtendedEdge, ELK as ElkEngine } from "elkjs/lib/elk-api";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import {
  DAG_GROUP_HEADER_HEIGHT,
  DAG_GROUP_MIN_WIDTH,
  DAG_NODE_WIDTH,
  DAG_NODE_HEIGHT,
} from "./dag-constants";

export interface DagLayoutNodeInput {
  id: string;
  width: number;
  height: number;
  groupId?: string | null;
  parentIssueId?: string | null;
  stage?: number | null;
}
export interface DagLayoutGroupInput {
  id: string;
  parentId: string | null;
  collapsed: boolean;
  independent: boolean;
}
export interface DagLayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}
export interface DagPoint {
  x: number;
  y: number;
}
export interface DagPort extends DagPoint {
  id: string;
  type: "source" | "target";
}
export interface DagStageBand {
  stage: number;
  start: number;
  end: number;
}
export interface DagGroupBounds extends DagPoint {
  width: number;
  height: number;
  bands: DagStageBand[];
  stageConflict: boolean;
}
export interface DagLayoutResult {
  positions: Record<string, DagPoint>;
  groups: Record<string, DagGroupBounds>;
  routes: Record<string, DagPoint[]>;
  ports: Record<string, DagPort[]>;
}
export interface DagLayoutRequest {
  requestId: number;
  nodes: DagLayoutNodeInput[];
  edges: DagLayoutEdgeInput[];
  groups: DagLayoutGroupInput[];
  direction: DagDirection;
}
export interface DagLayoutResponse extends DagLayoutResult {
  requestId: number;
  elapsedMs: number;
  error?: string;
}

interface BoundaryPort extends ElkPort {
  edgeId: string;
  role: "source" | "target";
  flow: "in" | "out";
}
interface LocalLayout {
  id: string;
  width: number;
  height: number;
  positions: Map<string, DagPoint>;
  children: Map<string, LocalLayout>;
  ports: BoundaryPort[];
  sections: Map<string, DagPoint[]>;
  bands: DagStageBand[];
  stageConflict: boolean;
}

const PADDING = 28;
const STAGE_HEIGHT = 38;
const ROOT = "dag:layout-root";
const point = (n: { x?: number; y?: number }): DagPoint => {
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y))
    throw new Error("Incomplete DAG layout coordinates");
  return { x: n.x!, y: n.y! };
};
const same = (a: DagPoint, b: DagPoint) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
function section(edge: ElkExtendedEdge): DagPoint[] {
  const pieces = (edge.sections ?? []).map((s) => [
    s.startPoint,
    ...(s.bendPoints ?? []),
    s.endPoint,
  ]);
  return joinSections(pieces);
}
function joinSections(input: DagPoint[][]): DagPoint[] {
  const pieces = input.filter((p) => p.length > 1).map((p) => [...p]);
  if (!pieces.length) throw new Error("Missing DAG edge route");
  const start = pieces.findIndex(
    (p, i) => !pieces.some((q, j) => i !== j && same(q[q.length - 1]!, p[0]!)),
  );
  const path = pieces.splice(Math.max(0, start), 1)[0]!;
  while (pieces.length) {
    const next = pieces.findIndex((p) => same(path[path.length - 1]!, p[0]!));
    if (next < 0) throw new Error("Disconnected DAG boundary route");
    path.push(...pieces.splice(next, 1)[0]!.slice(1));
  }
  return path.filter((p, i) => i === 0 || !same(p, path[i - 1]!));
}

/** All geometry is produced in the existing worker. Each task-line layout has
 * boundary ports; a second ELK layout routes those ports between regular rows
 * (or columns). Joining matching port coordinates adds no hand-routed segments.
 * Boundary ports use the cross-flow side, so reserving a common row width/column
 * height never moves the ports or forces connectors through group headers. */
export async function layoutDagProjection(
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  direction: DagDirection,
  groupInputs: DagLayoutGroupInput[],
  engine: Pick<ElkEngine, "layout">,
): Promise<DagLayoutResult> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = new Map(groupInputs.map((g) => [g.id, g]));
  const hasTaskLines = groupInputs.some((g) => !g.independent && !g.parentId);
  const validEdges = edges.filter(
    (e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target,
  );
  const children = new Map<string, DagLayoutNodeInput[]>();
  for (const node of nodes) {
    const owner = node.groupId && groups.has(node.groupId) ? node.groupId : ROOT;
    const list = children.get(owner) ?? [];
    list.push(node);
    children.set(owner, list);
  }
  const parentOf = (id: string) => {
    const idOfGroup = byId.get(id)?.groupId;
    return idOfGroup && groups.has(idOfGroup) ? idOfGroup : ROOT;
  };
  const pathMemo = new Map<string, string[]>();
  function ancestry(id: string): string[] {
    const cached = pathMemo.get(id);
    if (cached) return cached;
    const result = [id],
      seen = new Set(result);
    let parent = parentOf(id);
    while (parent !== ROOT && !seen.has(parent)) {
      result.push(parent);
      seen.add(parent);
      parent = parentOf(parent);
    }
    result.push(ROOT);
    pathMemo.set(id, result);
    return result;
  }
  function direct(id: string, scope: string): string | null {
    const chain = ancestry(id),
      i = chain.indexOf(scope);
    return i < 0 ? null : i === 0 ? scope : chain[i - 1]!;
  }
  const adjacency = new Map<string, string[]>();
  for (const e of validEdges) {
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }
  // Analyze all display-only stage preferences together. A preference that
  // participates in a cycle through other task lines must yield to real edges.
  const planned = new Map(nodes.map((n) => [n.id, [...(adjacency.get(n.id) ?? [])]]));
  const boundaryOwners = new Map<string, string>();
  for (const scope of groups.keys()) {
    if (groups.get(scope)?.independent) continue;
    const members = children.get(scope) ?? [];
    const memberStages = new Map(
      members.filter((n) => n.stage != null).map((n) => [n.id, n.stage!]),
    );
    const stages = [...new Set(memberStages.values())].sort((a, b) => a - b);
    if (stages.length < 2) continue;
    const buckets = new Map<number, string[]>();
    for (const n of nodes) {
      const unit = direct(n.id, scope),
        stage = unit ? memberStages.get(unit) : undefined;
      if (stage == null) continue;
      const bucket = buckets.get(stage) ?? [];
      bucket.push(n.id);
      buckets.set(stage, bucket);
    }
    for (let i = 1; i < stages.length; i++) {
      const id = `stage-preference:${scope}:${i}`;
      boundaryOwners.set(id, scope);
      planned.set(id, [...(buckets.get(stages[i]!) ?? [])]);
      for (const before of buckets.get(stages[i - 1]!) ?? []) planned.get(before)!.push(id);
    }
  }
  // Iterative Kosaraju avoids recursion limits on long task chains.
  const reverse = new Map<string, string[]>();
  for (const id of planned.keys()) reverse.set(id, []);
  for (const [id, next] of planned) for (const target of next) reverse.get(target)?.push(id);
  const seen = new Set<string>(),
    order: string[] = [];
  for (const id of planned.keys()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{ id, cursor: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!,
        next = planned.get(top.id) ?? [];
      if (top.cursor === next.length) {
        order.push(top.id);
        stack.pop();
        continue;
      }
      const target = next[top.cursor++]!;
      if (!seen.has(target)) {
        seen.add(target);
        stack.push({ id: target, cursor: 0 });
      }
    }
  }
  const assigned = new Set<string>(),
    unsafeStages = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (assigned.has(id)) continue;
    const component: string[] = [],
      stack = [id];
    assigned.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of reverse.get(current) ?? [])
        if (!assigned.has(next)) {
          assigned.add(next);
          stack.push(next);
        }
    }
    if (component.length > 1)
      for (const item of component) {
        const owner = boundaryOwners.get(item);
        if (owner) unsafeStages.add(owner);
      }
  }
  const boundaryId = (scope: string, edge: DagLayoutEdgeInput, role: "source" | "target") =>
    `boundary:${scope}:${edge.id}:${role}`;
  function boundaryPorts(scope: string): BoundaryPort[] {
    if (scope === ROOT) return [];
    const result: BoundaryPort[] = [];
    for (const edge of validEdges) {
      const a = direct(edge.source, scope),
        b = direct(edge.target, scope);
      if (a === null && b === null) continue;
      if (a !== null && (b === null || a === scope))
        result.push({
          id: boundaryId(scope, edge, "source"),
          edgeId: edge.id,
          role: "source",
          flow: b !== null ? "in" : "out",
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": direction === "LR" ? "SOUTH" : "EAST" },
        });
      if (b !== null && (a === null || b === scope))
        result.push({
          id: boundaryId(scope, edge, "target"),
          edgeId: edge.id,
          role: "target",
          flow: a !== null ? "out" : "in",
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": direction === "LR" ? "SOUTH" : "EAST" },
        });
    }
    return result;
  }
  async function layoutScope(scope: string): Promise<LocalLayout> {
    const config = groups.get(scope),
      members = children.get(scope) ?? [];
    const local: LocalLayout = {
      id: scope,
      width: 0,
      height: 0,
      positions: new Map(),
      children: new Map(),
      ports: boundaryPorts(scope),
      sections: new Map(),
      bands: [],
      stageConflict: false,
    };
    const minWidth = direction === "LR" ? DAG_GROUP_MIN_WIDTH : 360;
    if (config?.collapsed) {
      local.width = minWidth;
      local.height = DAG_GROUP_HEADER_HEIGHT;
      local.ports.forEach((p, i) => {
        p.x =
          direction === "LR"
            ? 16 + ((i + 1) * (local.width - 32)) / (local.ports.length + 1)
            : local.width;
        p.y =
          direction === "LR"
            ? local.height
            : 16 + ((i + 1) * (local.height - 32)) / (local.ports.length + 1);
      });
      return local;
    }
    for (const member of members)
      if (groups.has(member.id)) local.children.set(member.id, await layoutScope(member.id));
    const internal = validEdges.filter(
      (e) => direct(e.source, scope) !== null && direct(e.target, scope) !== null,
    );
    const staged =
      scope === ROOT || config?.independent ? [] : members.filter((n) => n.stage != null);
    local.stageConflict = unsafeStages.has(scope);
    // An unordered task group uses a compact grid, with no invented rank/phase.
    if (
      scope !== ROOT &&
      !internal.length &&
      !local.ports.length &&
      !staged.length &&
      !local.children.size
    ) {
      const columns = Math.min(members.length, direction === "LR" ? 3 : 2);
      for (let i = 0; i < members.length; i++)
        local.positions.set(members[i]!.id, {
          x: PADDING + (i % columns) * (DAG_NODE_WIDTH + 16),
          y: DAG_GROUP_HEADER_HEIGHT + PADDING + Math.floor(i / columns) * (DAG_NODE_HEIGHT + 16),
        });
      local.width = Math.max(minWidth, columns * (DAG_NODE_WIDTH + 16) - 16 + PADDING * 2);
      local.height =
        DAG_GROUP_HEADER_HEIGHT +
        PADDING * 2 +
        Math.ceil(members.length / Math.max(1, columns)) * (DAG_NODE_HEIGHT + 16) -
        16;
      return local;
    }
    const allStaged = staged.length === members.length && staged.length > 0 && !local.stageConflict;
    const top =
      scope === ROOT ? PADDING : DAG_GROUP_HEADER_HEIGHT + PADDING + (allStaged ? STAGE_HEIGHT : 0);
    const flow =
      scope === ROOT && hasTaskLines
        ? direction === "LR"
          ? "DOWN"
          : "RIGHT"
        : direction === "LR"
          ? "RIGHT"
          : "DOWN";
    const nodeSpecs = new Map<string, ElkNode>();
    for (const member of members) {
      const child = local.children.get(member.id);
      nodeSpecs.set(member.id, {
        id: member.id,
        width: child?.width ?? member.width,
        height: child?.height ?? member.height,
        ports: child ? child.ports.map((p) => ({ ...p })) : [],
        layoutOptions: {
          "elk.portConstraints": child ? "FIXED_POS" : "FIXED_ORDER",
          ...(allStaged ? { "elk.partitioning.partition": String(member.stage) } : {}),
        },
      });
    }
    if (scope === ROOT && !hasTaskLines) {
      for (const [id, spec] of nodeSpecs)
        if (groups.get(id)?.independent) {
          spec.layoutOptions = {
            ...spec.layoutOptions,
            "elk.layered.layering.layerConstraint": "LAST",
          };
        }
    }
    const elkEdges: ElkExtendedEdge[] = [];
    const businessIds = new Map<string, string>();
    function endpoint(unit: string, edge: DagLayoutEdgeInput, role: "source" | "target") {
      if (unit === scope) return boundaryId(scope, edge, role);
      const spec = nodeSpecs.get(unit)!;
      if (groups.has(unit)) return boundaryId(unit, edge, role);
      const id = `task-port:${edge.id}:${role}`;
      const side =
        scope === ROOT && hasTaskLines
          ? "WEST"
          : role === "source"
            ? direction === "LR"
              ? "EAST"
              : "SOUTH"
            : direction === "LR"
              ? "WEST"
              : "NORTH";
      spec.ports!.push({ id, width: 0, height: 0, layoutOptions: { "elk.port.side": side } });
      return id;
    }
    for (const edge of validEdges) {
      const a = direct(edge.source, scope),
        b = direct(edge.target, scope);
      if ((a === null && b === null) || (a !== null && a === b && a !== scope)) continue;
      // A container endpoint at its own boundary has no internal segment.
      if ((a === scope && b === null) || (b === scope && a === null)) continue;
      const source = a === null ? boundaryId(scope, edge, "target") : endpoint(a, edge, "source");
      const target = b === null ? boundaryId(scope, edge, "source") : endpoint(b, edge, "target");
      const id = `route:${scope}:${edge.id}`;
      elkEdges.push({ id, sources: [source], targets: [target] });
      businessIds.set(id, edge.id);
    }
    // Mixed staged/unstaged siblings retain stage preferences without assigning
    // an artificial stage to the remaining nodes. These order edges never render.
    if (scope !== ROOT && staged.length > 1 && !allStaged && !local.stageConflict) {
      const stages = [...new Set(staged.map((n) => n.stage!))].sort((a, b) => a - b);
      for (let i = 1; i < stages.length; i++) {
        const id = `ordering:${scope}:${i}`;
        nodeSpecs.set(id, { id, width: 0, height: 0 });
        for (const node of staged) {
          if (node.stage === stages[i - 1])
            elkEdges.push({ id: `${id}:from:${node.id}`, sources: [node.id], targets: [id] });
          if (node.stage === stages[i])
            elkEdges.push({ id: `${id}:to:${node.id}`, sources: [id], targets: [node.id] });
        }
      }
    }
    if (scope === ROOT && hasTaskLines && nodeSpecs.size) {
      const crossSize = Math.max(
        ...[...nodeSpecs.values()].map((n) => (direction === "LR" ? n.width! : n.height!)),
      );
      let index = 0;
      for (const spec of nodeSpecs.values()) {
        if (direction === "LR") spec.width = crossSize;
        else spec.height = crossSize;
        if (!groups.has(spec.id)) {
          const count = spec.ports?.length ?? 0,
            height = byId.get(spec.id)!.height;
          spec.ports?.forEach((p, i) => {
            p.x = 0;
            p.y = 14 + ((i + 1) * (height - 28)) / (count + 1);
          });
        }
        spec.layoutOptions = {
          ...spec.layoutOptions,
          "elk.portConstraints": "FIXED_POS",
          "elk.partitioning.partition": String(index++),
        };
      }
    }
    const layoutOptions = {
      "elk.algorithm": "layered",
      "elk.direction": flow,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.separateConnectedComponents": "false",
      "elk.portConstraints": "FIXED_SIDE",
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${scope === ROOT ? 0 : minWidth},${scope === ROOT ? 0 : DAG_GROUP_HEADER_HEIGHT})`,
      "elk.spacing.nodeNode": "24",
      "elk.spacing.edgeNode": "18",
      "elk.spacing.edgeEdge": "12",
      "elk.layered.spacing.nodeNodeBetweenLayers": scope === ROOT ? "28" : "80",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "18",
      "elk.partitioning.activate": String((scope === ROOT && hasTaskLines) || allStaged),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.mergeEdges": "false",
      "elk.padding": `[top=${top},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
      ...(scope === ROOT && hasTaskLines ? { "elk.layered.nodePlacement.strategy": "SIMPLE" } : {}),
    };
    let graph: ElkNode = {
      id: scope,
      layoutOptions,
      children: [...nodeSpecs.values()],
      edges: elkEdges,
      ports: local.ports.map((p) => ({ ...p })),
    };
    if (local.ports.length) {
      // ELK requires the surrounding context to resolve a container's ports.
      // Zero-size terminals provide that context only; they are never visible.
      const terminals = local.ports.map((p) => ({ id: `terminal:${p.id}`, width: 0, height: 0 }));
      const wrapper: ElkNode = {
        id: `wrapper:${scope}`,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": flow,
          "elk.hierarchyHandling": "SEPARATE_CHILDREN",
        },
        children: [graph, ...terminals],
        edges: local.ports.map((p) => ({
          id: `terminal-edge:${p.id}`,
          sources: [p.flow === "out" ? p.id : `terminal:${p.id}`],
          targets: [p.flow === "out" ? `terminal:${p.id}` : p.id],
        })),
      };
      const result = await engine.layout(wrapper);
      graph = result.children!.find((n) => n.id === scope)!;
    } else graph = await engine.layout(graph);
    local.width = Math.max(scope === ROOT ? 0 : minWidth, graph.width ?? 0);
    local.height = Math.max(scope === ROOT ? 0 : DAG_GROUP_HEADER_HEIGHT, graph.height ?? 0);
    for (const member of graph.children ?? [])
      if (byId.has(member.id)) local.positions.set(member.id, point(member));
    local.ports = local.ports.map((p) => {
      const placed = graph.ports?.find((v) => v.id === p.id);
      if (!placed) throw new Error("Missing DAG boundary port");
      return { ...p, ...point(placed) };
    });
    for (const edge of graph.edges ?? []) {
      const business = businessIds.get(edge.id);
      if (business) local.sections.set(business, section(edge));
    }
    if (allStaged) {
      const bands = [...new Set(staged.map((n) => n.stage!))]
        .sort((a, b) => a - b)
        .map((stage) => {
          const membersInStage = staged.filter((n) => n.stage === stage);
          return {
            stage,
            min: Math.min(
              ...membersInStage.map((n) =>
                direction === "LR" ? local.positions.get(n.id)!.x : local.positions.get(n.id)!.y,
              ),
            ),
            max: Math.max(
              ...membersInStage.map((n) => {
                const p = local.positions.get(n.id)!,
                  child = local.children.get(n.id);
                return direction === "LR"
                  ? p.x + (child?.width ?? n.width)
                  : p.y + (child?.height ?? n.height);
              }),
            ),
          };
        });
      local.bands = bands.map((band, i) => ({
        stage: band.stage,
        start:
          i === 0
            ? direction === "LR"
              ? 0
              : DAG_GROUP_HEADER_HEIGHT
            : (bands[i - 1]!.max + band.min) / 2,
        end:
          i === bands.length - 1
            ? direction === "LR"
              ? local.width
              : local.height
            : (band.max + bands[i + 1]!.min) / 2,
      }));
    }
    return local;
  }
  const result: DagLayoutResult = { positions: {}, groups: {}, routes: {}, ports: {} };
  if (!nodes.length) return result;
  const root = await layoutScope(ROOT),
    routeParts = new Map<string, DagPoint[][]>();
  function collect(layout: LocalLayout, offset: DagPoint) {
    if (layout.id !== ROOT)
      result.groups[layout.id] = {
        ...offset,
        width: layout.width,
        height: layout.height,
        bands: layout.bands,
        stageConflict: layout.stageConflict,
      };
    for (const [id, p] of layout.positions) {
      const absolute = { x: offset.x + p.x, y: offset.y + p.y };
      result.positions[id] = absolute;
      const child = layout.children.get(id);
      if (child) collect(child, absolute);
    }
    for (const [id, points] of layout.sections) {
      const parts = routeParts.get(id) ?? [];
      parts.push(points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })));
      routeParts.set(id, parts);
    }
  }
  collect(root, { x: 0, y: 0 });
  for (const edge of validEdges) {
    const route = joinSections(routeParts.get(edge.id) ?? []);
    result.routes[edge.id] = route;
    for (const role of ["source", "target"] as const) {
      const id = edge[role],
        origin = result.positions[id]!;
      const end = role === "source" ? route[0]! : route[route.length - 1]!;
      (result.ports[id] ??= []).push({
        id: `${role}:${edge.id}`,
        type: role,
        x: end.x - origin.x,
        y: end.y - origin.y,
      });
    }
  }
  return result;
}
