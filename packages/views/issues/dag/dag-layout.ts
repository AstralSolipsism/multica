import type {
  ElkNode,
  ElkPort,
  ElkExtendedEdge,
  ELK as ElkEngine,
} from "elkjs/lib/elk-api";
import type { DagDirection } from "@multica/core/issues/stores/view-store";
import {
  DAG_GROUP_HEADER_HEIGHT,
  DAG_GROUP_MIN_WIDTH,
  DAG_NODE_WIDTH,
  DAG_NODE_HEIGHT,
  DAG_GROUP_TB_MIN_WIDTH,
  DAG_STAGE_HEADER_HEIGHT,
} from "./dag-constants";
import {
  buildStagePreferenceGraph,
  conflictingStageScopes,
} from "./dag-stage-preferences";

export interface DagLayoutNodeInput {
  id: string;
  width: number;
  height: number;
  groupId?: string | null;
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
const ROOT = "dag:layout-root";
const ROOT_FLOW = "dag:root-flow";
const AXIS = {
  LR: {
    coordinate: "x",
    size: "width",
    crossCoordinate: "y",
    crossSize: "height",
    flow: "RIGHT",
    rows: "DOWN",
    boundary: "SOUTH",
    source: "EAST",
    target: "WEST",
    minWidth: DAG_GROUP_MIN_WIDTH,
    columns: 3,
    bandStart: 0,
  },
  TB: {
    coordinate: "y",
    size: "height",
    crossCoordinate: "x",
    crossSize: "width",
    flow: "DOWN",
    rows: "RIGHT",
    boundary: "EAST",
    source: "SOUTH",
    target: "NORTH",
    minWidth: DAG_GROUP_TB_MIN_WIDTH,
    columns: 2,
    bandStart: DAG_GROUP_HEADER_HEIGHT,
  },
} as const;
type Axis = (typeof AXIS)[DagDirection];
interface LayoutContext {
  byId: Map<string, DagLayoutNodeInput>;
  groups: Map<string, DagLayoutGroupInput>;
  children: Map<string, DagLayoutNodeInput[]>;
  validEdges: DagLayoutEdgeInput[];
  ancestry: Map<string, string[]>;
  hasTaskLines: boolean;
  axis: Axis;
  unsafeStages: Set<string>;
  engine: Pick<ElkEngine, "layout">;
}
interface ScopeContext {
  context: LayoutContext;
  local: LocalLayout;
  members: DagLayoutNodeInput[];
  staged: DagLayoutNodeInput[];
  allStaged: boolean;
  internal: DagLayoutEdgeInput[];
  root: boolean;
  minWidth: number;
  headerHeight: number;
}
type ScopeKind = "collapsed" | "grid" | "rootRows" | "rootFlow" | "line";
interface ScopeGraph {
  graph: ElkNode;
  businessIds: Map<string, string>;
}
const point = (n: { x?: number; y?: number }): DagPoint => {
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y))
    throw new Error("Incomplete DAG layout coordinates");
  return { x: n.x!, y: n.y! };
};
const same = (a: DagPoint, b: DagPoint) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
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

function createContext(
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  direction: DagDirection,
  groupInputs: DagLayoutGroupInput[],
  engine: LayoutContext["engine"],
): LayoutContext {
  const groups = new Map(groupInputs.map((g) => [g.id, g]));
  const hasTaskLines = groupInputs.some((g) => !g.independent && !g.parentId);
  // Free dependency chains keep the selected direction inside one invisible row.
  const loose = hasTaskLines
    ? nodes.filter((n) => !n.groupId && !groups.has(n.id))
    : [];
  const looseIds = new Set(loose.map((n) => n.id));
  const members = nodes.map((n) =>
    looseIds.has(n.id) ? { ...n, groupId: ROOT_FLOW } : n,
  );
  if (loose.length) {
    members.splice(members.findIndex((node) => looseIds.has(node.id)), 0, {
      id: ROOT_FLOW, width: 0, height: 0,
    });
    groups.set(ROOT_FLOW, {
      id: ROOT_FLOW,
      parentId: null,
      collapsed: false,
      independent: true,
    });
  }
  const byId = new Map(members.map((n) => [n.id, n]));
  const children = new Map<string, DagLayoutNodeInput[]>();
  for (const node of members) {
    const owner =
      node.groupId && groups.has(node.groupId) ? node.groupId : ROOT;
    const list = children.get(owner) ?? [];
    list.push(node);
    children.set(owner, list);
  }
  const context: LayoutContext = {
    byId,
    groups,
    children,
    hasTaskLines,
    engine,
    axis: AXIS[direction],
    ancestry: new Map(),
    unsafeStages: new Set(),
    validEdges: edges.filter(
      (e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target,
    ),
  };
  for (const id of byId.keys()) ancestry(context, id);
  context.unsafeStages = conflictingStageScopes(
    buildStagePreferenceGraph(
      context.byId,
      groups,
      children,
      context.validEdges,
      (id, scope) => direct(context, id, scope),
    ),
  );
  return context;
}
function ancestry(context: LayoutContext, id: string): string[] {
  const cached = context.ancestry.get(id);
  if (cached) return cached;
  const result = [id],
    seen = new Set(result);
  let parent = context.byId.get(id)?.groupId;
  while (parent && context.groups.has(parent) && !seen.has(parent)) {
    result.push(parent);
    seen.add(parent);
    parent = context.byId.get(parent)?.groupId;
  }
  result.push(ROOT);
  context.ancestry.set(id, result);
  return result;
}
function direct(
  context: LayoutContext,
  id: string,
  scope: string,
): string | null {
  const chain = context.ancestry.get(id)!,
    i = chain.indexOf(scope);
  if (i < 0) return null;
  return i === 0 ? scope : chain[i - 1]!;
}
const boundaryId = (
  scope: string,
  edge: DagLayoutEdgeInput,
  role: "source" | "target",
) => `boundary:${scope}:${edge.id}:${role}`;
function boundaryPorts(context: LayoutContext, scope: string): BoundaryPort[] {
  if (scope === ROOT) return [];
  const result: BoundaryPort[] = [];
  for (const edge of context.validEdges) {
    const a = direct(context, edge.source, scope),
      b = direct(context, edge.target, scope);
    const add = (role: "source" | "target", flow: "in" | "out") =>
      result.push({
        id: boundaryId(scope, edge, role),
        edgeId: edge.id,
        role,
        flow,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": context.axis.boundary },
      });
    if (a !== null && (b === null || a === scope))
      add("source", b !== null ? "in" : "out");
    if (b !== null && (a === null || b === scope))
      add("target", a !== null ? "out" : "in");
  }
  return result;
}
function scopeContext(context: LayoutContext, id: string): ScopeContext {
  const root = id === ROOT || id === ROOT_FLOW;
  const members = context.children.get(id) ?? [];
  const staged =
    root || context.groups.get(id)?.independent
      ? []
      : members.filter((n) => n.stage != null);
  const stageConflict = context.unsafeStages.has(id);
  return {
    context,
    root,
    members,
    staged,
    minWidth: root ? 0 : context.axis.minWidth,
    headerHeight: root ? 0 : DAG_GROUP_HEADER_HEIGHT,
    allStaged:
      staged.length === members.length && staged.length > 0 && !stageConflict,
    internal: context.validEdges.filter(
      (e) =>
        direct(context, e.source, id) !== null &&
        direct(context, e.target, id) !== null,
    ),
    local: {
      id,
      width: 0,
      height: 0,
      positions: new Map(),
      children: new Map(),
      ports: boundaryPorts(context, id),
      sections: new Map(),
      bands: [],
      stageConflict,
    },
  };
}
function classifyScope(scope: ScopeContext): ScopeKind {
  const { context, local, root, internal, staged, members } = scope;
  if (context.groups.get(local.id)?.collapsed) return "collapsed";
  if (root)
    return local.id === ROOT && context.hasTaskLines ? "rootRows" : "rootFlow";
  if (
    !internal.length &&
    !local.ports.length &&
    !staged.length &&
    !members.some((m) => context.groups.has(m.id))
  )
    return "grid";
  return "line";
}
function buildCollapsed({
  local,
  minWidth,
  headerHeight,
  context: { axis },
}: ScopeContext): LocalLayout {
  local.width = minWidth;
  local.height = headerHeight;
  local.ports.forEach((p, i) => {
    p[axis.coordinate] =
      16 + ((i + 1) * (local[axis.size] - 32)) / (local.ports.length + 1);
    p[axis.crossCoordinate] = local[axis.crossSize];
  });
  return local;
}
function buildGrid({
  local,
  members,
  minWidth,
  headerHeight,
  context: { axis },
}: ScopeContext): LocalLayout {
  const columns = Math.min(members.length, axis.columns);
  members.forEach((member, i) =>
    local.positions.set(member.id, {
      x: PADDING + (i % columns) * (DAG_NODE_WIDTH + 16),
      y:
        headerHeight +
        PADDING +
        Math.floor(i / columns) * (DAG_NODE_HEIGHT + 16),
    }),
  );
  local.width = Math.max(
    minWidth,
    columns * (DAG_NODE_WIDTH + 16) - 16 + PADDING * 2,
  );
  local.height =
    headerHeight +
    PADDING * 2 +
    Math.ceil(members.length / Math.max(1, columns)) * (DAG_NODE_HEIGHT + 16) -
    16;
  return local;
}
function nodeSpecs({
  members,
  local,
  allStaged,
}: ScopeContext): Map<string, ElkNode> {
  return new Map(
    members.map((member) => {
      const child = local.children.get(member.id);
      return [
        member.id,
        {
          id: member.id,
          width: child?.width ?? member.width,
          height: child?.height ?? member.height,
          ports: child ? child.ports.map((p) => ({ ...p })) : [],
          layoutOptions: {
            "elk.portConstraints": child ? "FIXED_POS" : "FIXED_ORDER",
            ...(allStaged
              ? { "elk.partitioning.partition": String(member.stage) }
              : {}),
          },
        },
      ];
    }),
  );
}
function endpoint(
  scope: ScopeContext,
  specs: Map<string, ElkNode>,
  unit: string,
  edge: DagLayoutEdgeInput,
  role: "source" | "target",
): string {
  const { context, local } = scope;
  if (unit === local.id) return boundaryId(local.id, edge, role);
  if (context.groups.has(unit)) return boundaryId(unit, edge, role);
  const id = `task-port:${edge.id}:${role}`;
  specs.get(unit)!.ports!.push({
    id,
    width: 0,
    height: 0,
    layoutOptions: { "elk.port.side": context.axis[role] },
  });
  return id;
}
function scopeEdges(
  scope: ScopeContext,
  specs: Map<string, ElkNode>,
): { edges: ElkExtendedEdge[]; businessIds: Map<string, string> } {
  const edges: ElkExtendedEdge[] = [],
    businessIds = new Map<string, string>();
  const {
    context,
    local: { id: scopeId },
  } = scope;
  for (const edge of context.validEdges) {
    const a = direct(context, edge.source, scopeId),
      b = direct(context, edge.target, scopeId);
    if ((a === null && b === null) || (a !== null && a === b && a !== scopeId))
      continue;
    if ((a === scopeId && b === null) || (b === scopeId && a === null))
      continue;
    const source =
      a === null
        ? boundaryId(scopeId, edge, "target")
        : endpoint(scope, specs, a, edge, "source");
    const target =
      b === null
        ? boundaryId(scopeId, edge, "source")
        : endpoint(scope, specs, b, edge, "target");
    const id = `route:${scopeId}:${edge.id}`;
    edges.push({ id, sources: [source], targets: [target] });
    businessIds.set(id, edge.id);
  }
  return { edges, businessIds };
}
function addStageOrdering(
  scope: ScopeContext,
  specs: Map<string, ElkNode>,
  edges: ElkExtendedEdge[],
) {
  if (scope.allStaged || scope.local.stageConflict) return;
  const stages = [...new Set(scope.staged.map((n) => n.stage!))].sort(
    (a, b) => a - b,
  );
  for (let i = 1; i < stages.length; i++) {
    const id = `ordering:${scope.local.id}:${i}`;
    specs.set(id, { id, width: 0, height: 0 });
    for (const node of scope.staged) {
      if (node.stage === stages[i - 1])
        edges.push({
          id: `${id}:from:${node.id}`,
          sources: [node.id],
          targets: [id],
        });
      if (node.stage === stages[i])
        edges.push({
          id: `${id}:to:${node.id}`,
          sources: [id],
          targets: [node.id],
        });
    }
  }
}
function rootRows(specs: Map<string, ElkNode>, axis: Axis) {
  const crossSize = Math.max(
    0,
    ...[...specs.values()].map((n) => n[axis.size]!),
  );
  let index = 0;
  for (const spec of specs.values()) {
    spec[axis.size] = crossSize;
    spec.layoutOptions = {
      ...spec.layoutOptions,
      "elk.portConstraints": "FIXED_POS",
      "elk.partitioning.partition": String(index++),
    };
  }
}
/** Pure graph construction; ELK execution and result reading are separate. */
function buildScopeGraph(scope: ScopeContext, rows = false): ScopeGraph {
  const { context, local, root, allStaged, minWidth, headerHeight } = scope;
  const specs = nodeSpecs(scope);
  const { edges, businessIds } = scopeEdges(scope, specs);
  addStageOrdering(scope, specs, edges);
  if (rows) rootRows(specs, context.axis);
  else if (root)
    for (const spec of specs.values()) {
      if (context.groups.get(spec.id)?.independent)
        spec.layoutOptions = {
          ...spec.layoutOptions,
          "elk.layered.layering.layerConstraint": "LAST",
        };
    }
  const top =
    headerHeight + PADDING + (allStaged ? DAG_STAGE_HEADER_HEIGHT : 0);
  return {
    businessIds,
    graph: {
      id: local.id,
      children: [...specs.values()],
      edges,
      ports: local.ports.map((p) => ({ ...p })),
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": rows ? context.axis.rows : context.axis.flow,
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.separateConnectedComponents": "false",
        "elk.portConstraints": "FIXED_SIDE",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${minWidth},${headerHeight})`,
        "elk.spacing.nodeNode": "24",
        "elk.spacing.edgeNode": "18",
        "elk.spacing.edgeEdge": "12",
        "elk.layered.spacing.nodeNodeBetweenLayers": root ? "28" : "80",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
        "elk.layered.spacing.edgeNodeBetweenLayers": "18",
        "elk.partitioning.activate": String(rows || allStaged),
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.mergeEdges": "false",
        "elk.padding": `[top=${top},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
        ...(rows ? { "elk.layered.nodePlacement.strategy": "SIMPLE" } : {}),
      },
    },
  };
}
async function runElk(scope: ScopeContext, graph: ElkNode): Promise<ElkNode> {
  const { context, local } = scope;
  if (!local.ports.length) return context.engine.layout(graph);
  // Zero-size terminals give ELK the surrounding context for boundary ports.
  const wrapper: ElkNode = {
    id: `wrapper:${local.id}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": graph.layoutOptions!["elk.direction"]!,
      "elk.hierarchyHandling": "SEPARATE_CHILDREN",
    },
    children: [
      graph,
      ...local.ports.map((p) => ({
        id: `terminal:${p.id}`,
        width: 0,
        height: 0,
      })),
    ],
    edges: local.ports.map((p) => ({
      id: `terminal-edge:${p.id}`,
      sources: [p.flow === "out" ? p.id : `terminal:${p.id}`],
      targets: [p.flow === "out" ? `terminal:${p.id}` : p.id],
    })),
  };
  const result = await context.engine.layout(wrapper);
  return result.children!.find((n) => n.id === local.id)!;
}
function stageBands({
  staged,
  local,
  context: { axis },
}: ScopeContext): DagStageBand[] {
  const bands = [...new Set(staged.map((n) => n.stage!))]
    .sort((a, b) => a - b)
    .map((stage) => {
      const members = staged.filter((n) => n.stage === stage);
      return {
        stage,
        min: Math.min(
          ...members.map((n) => local.positions.get(n.id)![axis.coordinate]),
        ),
        max: Math.max(
          ...members.map(
            (n) =>
              local.positions.get(n.id)![axis.coordinate] +
              (local.children.get(n.id)?.[axis.size] ?? n[axis.size]),
          ),
        ),
      };
    });
  return bands.map((band, i) => ({
    stage: band.stage,
    start: i === 0 ? axis.bandStart : (bands[i - 1]!.max + band.min) / 2,
    end:
      i === bands.length - 1
        ? local[axis.size]
        : (band.max + bands[i + 1]!.min) / 2,
  }));
}
function readScopeLayout(
  scope: ScopeContext,
  graph: ElkNode,
  businessIds: Map<string, string>,
): LocalLayout {
  const { local, context, minWidth, headerHeight } = scope;
  local.width = Math.max(minWidth, graph.width ?? 0);
  local.height = Math.max(headerHeight, graph.height ?? 0);
  for (const member of graph.children ?? [])
    if (context.byId.has(member.id))
      local.positions.set(member.id, point(member));
  local.ports = local.ports.map((p) => {
    const placed = graph.ports?.find((v) => v.id === p.id);
    if (!placed) throw new Error("Missing DAG boundary port");
    return { ...p, ...point(placed) };
  });
  for (const edge of graph.edges ?? []) {
    const business = businessIds.get(edge.id);
    if (business) local.sections.set(business, section(edge));
  }
  if (scope.allStaged) local.bands = stageBands(scope);
  return local;
}
async function buildFlow(
  scope: ScopeContext,
  rows = false,
): Promise<LocalLayout> {
  const built = buildScopeGraph(scope, rows);
  return readScopeLayout(
    scope,
    await runElk(scope, built.graph),
    built.businessIds,
  );
}
function buildRootRows(scope: ScopeContext) {
  return buildFlow(scope, true);
}
function buildRootFlow(scope: ScopeContext) {
  return buildFlow(scope);
}
function buildLine(scope: ScopeContext) {
  return buildFlow(scope);
}
const BUILDERS = {
  collapsed: buildCollapsed,
  grid: buildGrid,
  rootRows: buildRootRows,
  rootFlow: buildRootFlow,
  line: buildLine,
} satisfies Record<
  ScopeKind,
  (scope: ScopeContext) => LocalLayout | Promise<LocalLayout>
>;
async function layoutScope(
  context: LayoutContext,
  id: string,
): Promise<LocalLayout> {
  const scope = scopeContext(context, id);
  const kind = classifyScope(scope);
  if (kind !== "collapsed")
    for (const member of scope.members) {
      if (context.groups.has(member.id))
        scope.local.children.set(
          member.id,
          await layoutScope(context, member.id),
        );
    }
  return BUILDERS[kind](scope);
}
function collectLayout(
  layout: LocalLayout,
  offset: DagPoint,
  result: DagLayoutResult,
  routeParts: Map<string, DagPoint[][]>,
) {
  if (layout.id !== ROOT && layout.id !== ROOT_FLOW)
    result.groups[layout.id] = {
      ...offset,
      width: layout.width,
      height: layout.height,
      bands: layout.bands,
      stageConflict: layout.stageConflict,
    };
  for (const [id, p] of layout.positions) {
    const absolute = { x: offset.x + p.x, y: offset.y + p.y };
    if (id !== ROOT_FLOW) result.positions[id] = absolute;
    const child = layout.children.get(id);
    if (child) collectLayout(child, absolute, result, routeParts);
  }
  for (const [id, points] of layout.sections) {
    const parts = routeParts.get(id) ?? [];
    parts.push(points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })));
    routeParts.set(id, parts);
  }
}
/** Each task line owns boundary ports; root rows route between their fixed ports. */
export async function layoutDagProjection(
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  direction: DagDirection,
  groupInputs: DagLayoutGroupInput[],
  engine: LayoutContext["engine"],
): Promise<DagLayoutResult> {
  const result: DagLayoutResult = {
    positions: {},
    groups: {},
    routes: {},
    ports: {},
  };
  if (!nodes.length) return result;
  const context = createContext(nodes, edges, direction, groupInputs, engine);
  const root = await layoutScope(context, ROOT),
    routeParts = new Map<string, DagPoint[][]>();
  collectLayout(root, { x: 0, y: 0 }, result, routeParts);
  for (const edge of context.validEdges) {
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
