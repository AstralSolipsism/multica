import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api";
import { DAG_FLOW, DAG_GROUP_HEADER_HEIGHT, DAG_GROUP_MIN_WIDTH, DAG_STAGE_HEADER_HEIGHT } from "./dag-constants";
import type { DagLayoutNodeInput, DagPoint } from "./dag-scene";
import type { DagSceneGeometry, DagSceneInput } from "./dag-scene";
import { buildStagePreferenceGraph, conflictingStageScopes } from "./dag-stage-preferences";
import { cleanDagPath, dagSceneSegments } from "./dag-scene-geometry";

const ROOT = "scene:root", PAD = 28, LAYER_GAP = 64;
const portId = (id: string, role: "input" | "output") => JSON.stringify([id, role]);
const zoneId = (side: string) => `scene:zone:${side}`;
const partition = { upstream: 0, current: 1, downstream: 2 };
const options: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": DAG_FLOW.direction,
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.favorStraightEdges": "false",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
  // Bottom-up crossing sweeps keep small nested lines within the entry budget.
  // INCLUDE_CHILDREN still owns placement and all cross-hierarchy routing.
  "elk.layered.crossingMinimization.hierarchicalSweepiness": "-1",
  "elk.layered.mergeEdges": "false",
  "elk.layered.mergeHierarchyEdges": "true",
  "elk.layered.thoroughness": "1",
  "elk.randomSeed": "1",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "16",
  "elk.spacing.edgeEdge": "12",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
  "elk.layered.spacing.edgeNodeBetweenLayers": "16",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.padding": `[top=${PAD},left=${PAD},bottom=${PAD},right=${PAD}]`,
};

function stageScopes(input: DagSceneInput) {
  const nested = new Set(input.frames.map((f) => f.parentId));
  const candidates = new Set(input.frames.filter((f) => !nested.has(f.id)).map((f) => f.id));
  const members: DagLayoutNodeInput[] = [
    ...input.nodes.map((n) => ({ ...n, groupId: n.parentId })),
    ...input.frames.map((f) => ({ id: f.id, groupId: f.parentId, width: 0, height: 0, stage: null })),
  ];
  const byId = new Map(members.map((n) => [n.id, n]));
  const children = new Map(input.frames.map((f) => [f.id, [] as DagLayoutNodeInput[]]));
  for (const member of members) children.get(member.groupId ?? "")?.push(member);
  for (const [id, nodes] of children) {
    if (!nodes.length || nodes.some((n) => n.stage == null) || new Set(nodes.map((n) => n.stage)).size < 2) candidates.delete(id);
  }
  const groups = new Map(input.frames.map((f) => [f.id, { id: f.id, parentId: f.parentId, collapsed: false, independent: !candidates.has(f.id) }]));
  const direct = (id: string, scope: string): string | null => {
    let node = byId.get(id);
    while (node) {
      if (node.groupId === scope) return node.id;
      node = byId.get(node.groupId ?? "");
    }
    return null;
  };
  const conflicts = conflictingStageScopes(buildStagePreferenceGraph(byId, groups, children, input.edges, direct));
  for (const id of conflicts) candidates.delete(id);
  return candidates;
}

function ports(id: string, width?: number, height?: number): NonNullable<ElkNode["ports"]> {
  return (["input", "output"] as const).map((role) => ({
    id: portId(id, role), width: 0, height: 0,
    ...(width !== undefined && height !== undefined ? { x: role === "input" ? 0 : width, y: height / 2 } : {}),
    layoutOptions: { "elk.port.side": role === "input" ? DAG_FLOW.inputSide : DAG_FLOW.outputSide },
  }));
}

export function buildDagSceneGraph(input: DagSceneInput) {
  // Dependency depth supplies the line's horizontal ranks; NETWORK_SIMPLEX
  // still places nodes within those ranks and handles their port alignment.
  const sceneOptions: LayoutOptions = { ...options, ...(input.kind === "line" ? { "elk.layered.layering.strategy": "LONGEST_PATH" } : {}) };
  const stages = stageScopes(input);
  const usedPorts = new Set(input.edges.flatMap((edge) => [portId(edge.source, "output"), portId(edge.target, "input")]));
  const stagedMembers = new Map([...stages].map((id) => [id, input.nodes.filter((n) => n.parentId === id)]));
  for (const members of stagedMembers.values()) for (const node of members) {
    usedPorts.add(portId(node.id, "input")); usedPorts.add(portId(node.id, "output"));
  }
  const connectedPorts = (id: string, width?: number, height?: number) => ports(id, width, height).filter((port) => usedPorts.has(port.id));
  const specs = new Map<string, ElkNode>();
  for (const frame of input.frames) specs.set(frame.id, {
    id: frame.id, children: [], ports: connectedPorts(frame.id),
    layoutOptions: {
      ...sceneOptions,
      "elk.portConstraints": "FIXED_SIDE",
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${DAG_GROUP_MIN_WIDTH},${DAG_GROUP_HEADER_HEIGHT + PAD * 2})`,
      "elk.padding": `[top=${DAG_GROUP_HEADER_HEIGHT + PAD + (stages.has(frame.id) ? DAG_STAGE_HEADER_HEIGHT : 0)},left=${PAD},bottom=${PAD},right=${PAD}]`,
    },
  });
  for (const node of input.nodes) specs.set(node.id, {
    id: node.id, width: node.width, height: node.height, ports: connectedPorts(node.id, node.width, node.height),
    layoutOptions: {
      "elk.portConstraints": "FIXED_POS",
      ...(input.kind === "line" && node.side ? { "elk.layered.layering.layerConstraint": node.side === "upstream" ? "FIRST" : "LAST" } : {}),
    },
  });
  const graph: ElkNode = { id: ROOT, children: [], edges: [], layoutOptions: { ...sceneOptions } };
  if (input.kind === "overview") {
    graph.layoutOptions!["elk.layered.considerModelOrder.strategy"] = "NODES";
    graph.layoutOptions!["elk.layered.considerModelOrder.components"] = "MODEL_ORDER";
    // Overview has no frames. Compound processing would disable disconnected
    // component packing and stack unrelated lines in one enormous column.
    graph.layoutOptions!["elk.hierarchyHandling"] = "SEPARATE_CHILDREN";
  }
  if (input.kind === "focus") {
    graph.layoutOptions!["elk.partitioning.activate"] = "true";
    // Invisible scopes provide a strict horizontal order even when one task
    // line has members on both sides of the focused task.
    for (const side of ["upstream", "current", "downstream"] as const) {
      const spec: ElkNode = { id: zoneId(side), children: [], layoutOptions: { ...sceneOptions, "elk.partitioning.partition": String(partition[side]), "elk.padding": "[top=0,left=0,bottom=0,right=0]" } };
      specs.set(spec.id, spec);
    }
  }
  for (const entity of [...input.frames, ...input.nodes]) {
    const parent = specs.get(entity.parentId ?? "") ?? (input.kind === "focus" && entity.side ? specs.get(zoneId(entity.side)) : graph)!;
    parent.children!.push(specs.get(entity.id)!);
  }
  if (input.kind === "focus") for (const side of ["upstream", "current", "downstream"] as const) {
    const zone = specs.get(zoneId(side))!;
    if (zone.children!.length) graph.children!.push(zone);
  }
  graph.edges = input.edges.map((edge) => ({ id: edge.id, sources: [portId(edge.source, "output")], targets: [portId(edge.target, "input")] }));
  // Nested ELK partitions do not reliably order disconnected members under
  // INCLUDE_CHILDREN. Invisible stage boundaries connect the safe precedence
  // constraints without adding all-to-all edges or visible dependency routes.
  for (const [id, members] of stagedMembers) {
    const values = [...new Set(members.map((n) => n.stage!))].sort((a, b) => a - b);
    const ids = new Set(members.map((n) => n.id));
    const outgoing = new Map(members.map((n) => [n.id, [] as string[]]));
    for (const edge of input.edges) if (ids.has(edge.source) && ids.has(edge.target)) outgoing.get(edge.source)!.push(edge.target);
    const reaches = (source: string, targets: string[]) => {
      const seen = new Set<string>(), pending = [source];
      while (pending.length) {
        const next = pending.pop()!;
        if (seen.has(next)) continue;
        seen.add(next); pending.push(...outgoing.get(next)!);
      }
      return targets.every((target) => seen.has(target));
    };
    for (let i = 1; i < values.length; i++) {
      const earlier = members.filter((n) => n.stage === values[i - 1]), later = members.filter((n) => n.stage === values[i]);
      // Existing paths already enforce strict column separation. Adding a
      // redundant all-member boundary inflates ELK's compound dummy graph.
      if (earlier.every((n) => reaches(n.id, later.map((n) => n.id)))) continue;
      const anchor = JSON.stringify(["stage-boundary", id, i]);
      specs.get(id)!.children!.push({ id: anchor, width: 0, height: 0 });
      for (const node of members) {
        if (node.stage === values[i - 1]) graph.edges.push({ id: `${anchor}:from:${node.id}`, sources: [portId(node.id, "output")], targets: [anchor] });
        if (node.stage === values[i]) graph.edges.push({ id: `${anchor}:to:${node.id}`, sources: [anchor], targets: [portId(node.id, "input")] });
      }
    }
  }
  return { graph, stages };
}

/** Frames with one child frame and no own dependency endpoints contribute
 * padding, not another ordering problem. Fold that padding into ELK, then
 * restore every frame face in the public geometry. Explicit endpoints keep
 * their ELK node so their port positions are always solved by the engine. */
function foldUnaryFrames(graph: ElkNode, input: DagSceneInput, stages: ReadonlySet<string>) {
  type Inset = { top: number; left: number; right: number; bottom: number };
  type Wrapper = { id: string; inset: Inset };
  const frames = new Set(input.frames.map((f) => f.id));
  const endpoints = new Set(input.edges.flatMap((e) => [e.source, e.target]));
  const padding = new Map([...frames].map((id) => [id, { top: DAG_GROUP_HEADER_HEIGHT + PAD + (stages.has(id) ? DAG_STAGE_HEADER_HEIGHT : 0), left: PAD, right: PAD, bottom: PAD }]));
  const minimumWidth = new Map([...frames].map((id) => [id, DAG_GROUP_MIN_WIDTH]));
  const wrappers = new Map<string, Wrapper[]>();
  const add = (a: Inset, b: Inset): Inset => ({ top: a.top + b.top, left: a.left + b.left, right: a.right + b.right, bottom: a.bottom + b.bottom });
  function visit(node: ElkNode) {
    for (const child of node.children ?? []) visit(child);
    const child = node.children?.length === 1 ? node.children[0] : undefined;
    if (!child || !frames.has(node.id) || !frames.has(child.id) || endpoints.has(node.id) || endpoints.has(child.id)) return;
    const outer = padding.get(node.id)!, combined = add(outer, padding.get(child.id)!);
    wrappers.set(node.id, [{ id: child.id, inset: outer }, ...(wrappers.get(child.id) ?? []).map((inner) => ({ id: inner.id, inset: add(outer, inner.inset) }))]);
    wrappers.delete(child.id);
    padding.set(node.id, combined);
    const width = Math.max(minimumWidth.get(node.id)!, minimumWidth.get(child.id)! + outer.left + outer.right);
    minimumWidth.set(node.id, width);
    node.children = child.children;
    node.layoutOptions!["elk.padding"] = `[top=${combined.top},left=${combined.left},bottom=${combined.bottom},right=${combined.right}]`;
    node.layoutOptions!["elk.nodeSize.minimum"] = `(${width},${combined.top + combined.bottom})`;
  }
  visit(graph);
  return wrappers;
}

/** Compound/external IDs contain nested serialized identities. Keep them out
 * of ELK's repeated hashing and worker copies; the public geometry retains
 * the exact original IDs. This bijection is local to a single request. */
function compactGraphIds(graph: ElkNode) {
  const encoded = new Map<string, string>(), originals = new Map<string, string>();
  const encode = (id: string) => {
    if (!encoded.has(id)) { const short = `g${encoded.size}`; encoded.set(id, short); originals.set(short, id); }
    return encoded.get(id)!;
  };
  function visit(node: ElkNode, translate: (id: string) => string) {
    node.id = translate(node.id);
    for (const port of node.ports ?? []) port.id = translate(port.id);
    for (const edge of node.edges ?? []) {
      edge.id = translate(edge.id);
      edge.sources = edge.sources.map(translate); edge.targets = edge.targets.map(translate);
      const routed = edge as ElkExtendedEdge & { container?: string };
      if (routed.container) routed.container = translate(routed.container);
    }
    for (const child of node.children ?? []) visit(child, translate);
  }
  visit(graph, encode);
  return (result: ElkNode) => visit(result, (id) => originals.get(id) ?? id);
}

/** A serial run inside one stage/frame has no ordering or routing choices.
 * Reserve its full width in ELK, then restore its cards and straight internal
 * routes. Branches, merges, frame boundaries and stage boundaries stay in ELK.
 * This avoids solving dozens of identical degree-two layers in long lines. */
function foldSerialRuns(input: DagSceneInput) {
  const runs = new Map<string, DagSceneInput["nodes"]>();
  const internal = new Set<string>();
  if (input.kind !== "line") return { input, runs, internal };
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>(), outgoing = new Map<string, typeof input.edges>();
  for (const edge of input.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source) ?? []; list.push(edge); outgoing.set(edge.source, list);
  }
  const ids = [...byId.keys(), ...input.frames.map((f) => f.id)];
  const degree = new Map(incoming), queue = ids.filter((id) => !degree.get(id));
  for (let i = 0; i < queue.length; i++) for (const edge of outgoing.get(queue[i]!) ?? []) {
    const remaining = degree.get(edge.target)! - 1; degree.set(edge.target, remaining);
    if (!remaining) queue.push(edge.target);
  }
  // Retain the complete graph for ELK's cycle breaker, including a cycle with
  // an incoming branch (which can otherwise look like a serial run).
  if (queue.length !== ids.length) return { input, runs, internal };
  const next = new Map<string, (typeof input.edges)[number]>(), previous = new Set<string>();
  for (const node of input.nodes) {
    const edges = outgoing.get(node.id);
    if (edges?.length !== 1) continue;
    const edge = edges[0]!, target = byId.get(edge.target);
    if (!target || edge.sourceKind !== "task" || edge.targetKind !== "task" || incoming.get(target.id) !== 1 || !node.parentId || node.parentId !== target.parentId || node.stage !== target.stage || node.height !== target.height || node.side !== target.side) continue;
    next.set(node.id, edge); previous.add(target.id);
  }
  const representative = new Map<string, string>();
  for (const head of input.nodes) {
    if (!next.has(head.id) || previous.has(head.id)) continue;
    const members = [head];
    let edge = next.get(head.id);
    while (edge) {
      internal.add(edge.id);
      const member = byId.get(edge.target)!; members.push(member);
      representative.set(member.id, head.id); edge = next.get(member.id);
    }
    runs.set(head.id, members);
  }
  const nodes = input.nodes.filter((n) => !representative.has(n.id)).map((node) => {
    const members = runs.get(node.id);
    return members ? { ...node, width: members.reduce((sum, n) => sum + n.width, 0) + LAYER_GAP * (members.length - 1) } : node;
  });
  const edges = input.edges.filter((e) => !internal.has(e.id)).map((edge) => ({ ...edge, source: representative.get(edge.source) ?? edge.source, target: representative.get(edge.target) ?? edge.target }));
  return { input: { ...input, nodes, edges }, runs, internal };
}

export function emptyDagScene(quality: DagSceneGeometry["quality"] = "elk"): DagSceneGeometry {
  return { nodes: {}, frames: {}, ports: {}, routes: {}, segments: [], junctions: [], width: 0, height: 0, quality };
}

export function layoutDagIndependent(input: DagSceneInput): DagSceneGeometry {
  const result = emptyDagScene("grid"), columns = Math.min(3, input.nodes.length);
  for (let i = 0; i < input.nodes.length; i++) {
    const node = input.nodes[i]!;
    const box = { x: PAD + (i % columns) * (node.width + 16), y: PAD + Math.floor(i / columns) * (node.height + 16), width: node.width, height: node.height };
    result.nodes[node.id] = box;
    result.ports[node.id] = { input: { x: box.x, y: box.y + box.height / 2 }, output: { x: box.x + box.width, y: box.y + box.height / 2 } };
    result.width = Math.max(result.width, box.x + box.width + PAD);
    result.height = Math.max(result.height, box.y + box.height + PAD);
  }
  return result;
}

export async function layoutDagScene(input: DagSceneInput, engine: Pick<ELK, "layout">): Promise<DagSceneGeometry> {
  if (input.grid) return layoutDagIndependent(input);
  if (!input.nodes.length && !input.frames.length) return emptyDagScene();
  const folded = foldSerialRuns(input);
  const { graph, stages } = buildDagSceneGraph(folded.input);
  const wrappers = foldUnaryFrames(graph, folded.input, stages);
  const restoreIds = compactGraphIds(graph);
  const placed = await engine.layout(graph);
  restoreIds(placed);
  const result = emptyDagScene();
  result.width = placed.width ?? 0; result.height = placed.height ?? 0;
  const frameIds = new Set(input.frames.map((f) => f.id)), nodeIds = new Set(input.nodes.map((n) => n.id));
  const offsets = new Map<string, DagPoint>([[ROOT, { x: 0, y: 0 }]]);
  const edges: { edge: ElkExtendedEdge; parent: string }[] = [];
  function read(node: ElkNode, offset: DagPoint) {
    const origin = { x: offset.x + (node.x ?? 0), y: offset.y + (node.y ?? 0) };
    offsets.set(node.id, origin);
    const box = { ...origin, width: node.width ?? 0, height: node.height ?? 0 };
    if (nodeIds.has(node.id)) result.nodes[node.id] = box;
    if (frameIds.has(node.id)) result.frames[node.id] = { ...box, bands: [], stageMode: "labels" };
    for (const { id, inset } of wrappers.get(node.id) ?? []) {
      const inner = { x: box.x + inset.left, y: box.y + inset.top, width: box.width - inset.left - inset.right, height: box.height - inset.top - inset.bottom };
      result.frames[id] = { ...inner, bands: [], stageMode: "labels" };
      result.ports[id] = { input: { x: inner.x, y: inner.y + inner.height / 2 }, output: { x: inner.x + inner.width, y: inner.y + inner.height / 2 } };
    }
    if (nodeIds.has(node.id) || frameIds.has(node.id)) {
      const absolutePort = (role: "input" | "output") => {
        const port = node.ports?.find((p) => p.id === portId(node.id, role));
        // Unused logical ports need no ELK objects or dummy routing work.
        // They still exist in the geometry for hover overlays and future edges.
        if (!port) return { x: origin.x + (role === "input" ? 0 : box.width), y: origin.y + box.height / 2 };
        if (port.x === undefined || port.y === undefined) throw new Error(`Missing DAG port: ${node.id}`);
        return { x: origin.x + port.x, y: origin.y + port.y };
      };
      result.ports[node.id] = { input: absolutePort("input"), output: absolutePort("output") };
    }
    for (const edge of node.edges ?? []) edges.push({ edge, parent: node.id });
    for (const child of node.children ?? []) read(child, origin);
  }
  read(placed, { x: 0, y: 0 });
  for (const [id, members] of folded.runs) {
    const box = result.nodes[id]!;
    let x = box.x;
    for (const member of members) {
      result.nodes[member.id] = { x, y: box.y, width: member.width, height: member.height };
      result.ports[member.id] = { input: { x, y: box.y + member.height / 2 }, output: { x: x + member.width, y: box.y + member.height / 2 } };
      x += member.width + LAYER_GAP;
    }
  }
  for (const edge of input.edges) if (folded.internal.has(edge.id)) result.routes[edge.id] = [result.ports[edge.source]!.output, result.ports[edge.target]!.input];
  const businessEdges = new Set(input.edges.map((edge) => edge.id));
  for (const { edge, parent } of edges) {
    if (!businessEdges.has(edge.id)) continue;
    const container = (edge as ElkExtendedEdge & { container?: string }).container ?? parent;
    const offset = offsets.get(container)!;
    const pieces = (edge.sections ?? []).map((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
    if (!pieces.length) throw new Error(`Missing DAG route: ${edge.id}`);
    const start = pieces.findIndex((p) => !pieces.some((q) => q !== p && q.at(-1)!.x === p[0]!.x && q.at(-1)!.y === p[0]!.y));
    const points = pieces.splice(Math.max(0, start), 1)[0]!;
    while (pieces.length) {
      const end = points.at(-1)!;
      const next = pieces.findIndex((p) => p[0]!.x === end.x && p[0]!.y === end.y);
      if (next < 0) throw new Error(`Disconnected DAG route: ${edge.id}`);
      points.push(...pieces.splice(next, 1)[0]!.slice(1));
    }
    result.routes[edge.id] = cleanDagPath(points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })));
  }
  for (const id of stages) {
    const frame = result.frames[id]!;
    const members = input.nodes.filter((n) => n.parentId === id);
    const values = [...new Set(members.map((n) => n.stage!))].sort((a, b) => a - b);
    const ranges = values.map((stage) => {
      const boxes = members.filter((n) => n.stage === stage).map((n) => result.nodes[n.id]!);
      return { stage, min: Math.min(...boxes.map((b) => b.x)), max: Math.max(...boxes.map((b) => b.x + b.width)) };
    });
    // INCLUDE_CHILDREN can ignore a nested partition when it conflicts with
    // cross-hierarchy layering. Never draw overlapping / misleading columns.
    if (ranges.some((range, i) => i > 0 && range.min < ranges[i - 1]!.max)) continue;
    frame.stageMode = "columns";
    frame.bands = ranges.map((range, i) => ({ stage: range.stage,
      start: i === 0 ? 0 : (ranges[i - 1]!.max + range.min) / 2 - frame.x,
      end: i + 1 === ranges.length ? frame.width : (range.max + ranges[i + 1]!.min) / 2 - frame.x,
    }));
  }
  Object.assign(result, dagSceneSegments(input.edges, result.routes));
  return result;
}
