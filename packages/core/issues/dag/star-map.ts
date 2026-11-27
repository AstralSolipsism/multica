import type { IssueGraph } from "../../api/issue-graph-schemas";
import type { DagIssue, DagModelIndex } from "./model-index";
import { dagIssueFinished } from "./state";

export interface StarMapPoint {
  readonly x: number;
  readonly y: number;
}

export interface StarMapBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface StarMapViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type StarMapLayoutMode = "constellation" | "polar";

export interface StarMapNode {
  readonly id: string;
  readonly issue: DagIssue;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly projectId: string | null;
  readonly stage: number;
  readonly depth: number;
  readonly index: number;
  readonly childrenIds: string[];
  readonly children: readonly StarMapNode[];
  readonly descendantCount: number;
  readonly doneDescendants: number;
  readonly activeDescendants: number;
  readonly coreRadius: number;
  readonly domainRadius: number;
  readonly orbitRadius: number;
  readonly baseAngle: number;
  readonly angularVelocity: number;
  /** Static system anchor. Animated orbital coordinates belong to the renderer. */
  readonly anchor: StarMapPoint;
}

export type StarMapSectorGuide =
  | Readonly<{ kind: "cluster"; sector: IssueGraph["projects"][number]; cx: number; cy: number; radius: number }>
  | Readonly<{
    kind: "sector";
    sector: IssueGraph["projects"][number];
    start: number;
    end: number;
    mid: number;
    innerR: number;
    outerR: number;
  }>;

export interface StarMapEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "manual" | "wakeup" | "mention";
  readonly untilState?: string;
  readonly mutual?: boolean;
}

export interface StarMapHierarchy {
  readonly roots: StarMapNode[];
  readonly nodeById: Map<string, StarMapNode>;
  readonly nodes: StarMapNode[];
  readonly sectorGuides: StarMapSectorGuide[];
  readonly edges: StarMapEdge[];
}

export interface StarMapCameraOptions {
  readonly insets?: Readonly<{
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  }>;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly fill?: number;
}

type DraftNode = {
  -readonly [K in keyof StarMapNode]: StarMapNode[K];
} & {
  children: StarMapNode[];
  anchor: StarMapPoint;
};

const identifiers = new Intl.Collator(undefined, { numeric: true });
const stageOf = (issue: DagIssue) => issue.stage ?? 1;

function compareSiblings(a: DagIssue, b: DagIssue): number {
  return stageOf(a) - stageOf(b) || identifiers.compare(a.identifier, b.identifier) || a.id.localeCompare(b.id);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function point(x: number, y: number): StarMapPoint {
  return { x, y };
}

// Leaves 32.4px between root centers at 0.45x zoom, including room for labels and hit targets.
const minimumRootSpacing = 72;

function packStandaloneRings(count: number, firstRadius: number, arcSpan: number) {
  const rings: { radius: number; angles: number[] }[] = [];
  for (let placed = 0, ringIndex = 0; placed < count; ringIndex += 1) {
    const radius = firstRadius + ringIndex * minimumRootSpacing;
    const minimumAngle = 2 * Math.asin(minimumRootSpacing / (2 * radius));
    const capacity = Math.max(1, Math.floor(arcSpan / minimumAngle + 1e-9));
    const ringCount = Math.min(capacity, count - placed);
    const angles = Array.from({ length: ringCount }, (_, index) =>
      ((index + 0.5) / ringCount - 0.5) * arcSpan);
    rings.push({ radius, angles });
    placed += ringCount;
  }
  return rings;
}

function createNode(
  model: DagModelIndex,
  order: ReadonlyMap<string, number>,
  issue: DagIssue,
  parentId: string | null,
  rootId: string,
  depth: number,
): DraftNode {
  const childIssues = [...(model.forest.children.get(issue.id) ?? [])]
    .map((child) => model.issues.get(child.id)!)
    .sort(compareSiblings);
  const children = childIssues.map((child) => createNode(model, order, child, issue.id, rootId, depth + 1) as StarMapNode);
  const descendantCount = children.reduce((sum, child) => sum + 1 + child.descendantCount, 0);
  const node: DraftNode = {
    id: issue.id,
    issue,
    parentId,
    rootId,
    projectId: issue.projectId,
    stage: stageOf(issue),
    depth,
    index: order.get(issue.id)!,
    childrenIds: children.map((child) => child.id),
    children,
    descendantCount,
    doneDescendants: children.reduce((sum, child) => sum + (dagIssueFinished(child.issue) ? 1 : 0) + child.doneDescendants, 0),
    activeDescendants: children.reduce((sum, child) => sum + (dagIssueFinished(child.issue) ? 0 : 1) + child.activeDescendants, 0),
    coreRadius: depth === 0
      ? children.length ? 22 + Math.min(4.5, descendantCount * 0.25) : 14
      : children.length ? 14.5 : depth === 1 ? 11.5 : 9,
    domainRadius: 0,
    orbitRadius: 0,
    baseAngle: 0,
    angularVelocity: 0,
    anchor: point(0, 0),
  };
  if (children.length === 0) {
    node.domainRadius = depth === 0 ? 32 : node.coreRadius * 1.6;
    return node;
  }

  const stages = [...new Set(children.map((child) => child.stage))].sort((a, b) => a - b);
  let radius = node.coreRadius * 2.55;
  stages.forEach((stage, stageIndex) => {
    const group = children.filter((child) => child.stage === stage) as DraftNode[];
    const childDomain = Math.max(...group.map((child) => child.domainRadius));
    radius += stageIndex === 0
      ? Math.max(12, (childDomain - 16) * 0.75)
      : Math.max(46, childDomain * 1.05);
    const angularVelocity = 0.030 / Math.pow(stageIndex + 1, 0.62);
    group.forEach((child, childIndex) => {
      child.orbitRadius = radius;
      child.baseAngle = -Math.PI * 0.65 + childIndex * Math.PI * 2 / group.length + stageIndex * 1.08;
      child.angularVelocity = angularVelocity;
    });
    // The final envelope always contains the complete child system, at any depth.
    radius += Math.max(28, childDomain);
  });
  node.domainRadius = radius + 18;
  return node;
}

function layoutConstellation(roots: DraftNode[], sectors: (string | null)[], index: DagModelIndex): StarMapSectorGuide[] {
  const groups = new Map(sectors.map((sector) => [sector, roots.filter((root) => root.projectId === sector)]));
  const packing = sectors.map((sector) => {
    const sectorRoots = groups.get(sector)!;
    const suns = sectorRoots.filter((root) => root.children.length > 0)
      .sort((a, b) => b.domainRadius - a.domainRadius || identifiers.compare(a.issue.identifier, b.issue.identifier) || a.id.localeCompare(b.id));
    const standalones = sectorRoots.filter((root) => root.children.length === 0);
    let positions: StarMapPoint[] = [];
    let extent = suns.length === 0 ? 0 : 130;
    if (suns.length === 1) {
      positions = [point(0, 0)];
      extent = suns[0]!.domainRadius;
    } else if (suns.length === 2) {
      const first = suns[0]!, second = suns[1]!;
      const distance = first.domainRadius + 54 + second.domainRadius;
      const x = -distance * 0.5 + (first.domainRadius - second.domainRadius) * 0.5;
      positions = [point(x, 0), point(x + distance, 0)];
      extent = (first.domainRadius * 2 + 54 + second.domainRadius * 2) * 0.5;
    } else if (suns.length > 2) {
      const maxDomain = Math.max(...suns.map((sun) => sun.domainRadius));
      const ringRadius = (maxDomain + 27) / Math.sin(Math.PI / suns.length);
      positions = suns.map((_, i) => {
        const angle = -Math.PI * 0.5 + i * Math.PI * 2 / suns.length;
        return point(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius);
      });
      extent = ringRadius + maxDomain;
    }
    const standaloneArc = suns.length === 0 ? Math.PI * 2
      : Math.min(Math.PI * 1.35, Math.max(0.45, standalones.length * 0.28));
    const standaloneRings = packStandaloneRings(standalones.length, extent + minimumRootSpacing, standaloneArc);
    const outerStandaloneRadius = standaloneRings.length ? standaloneRings[standaloneRings.length - 1]!.radius : 0;
    return {
      sector, suns, standalones, positions, standaloneRings,
      outerBound: standalones.length ? outerStandaloneRadius + 36 : extent + 30,
    };
  });
  const maxOuter = Math.max(...packing.map((pack) => pack.outerBound));
  const count = packing.length;
  const clusterDistance = count === 1 ? 0 : Math.max(640, (maxOuter + 68) / Math.sin(Math.PI / count));
  const guides: StarMapSectorGuide[] = [];
  packing.forEach((pack, sectorIndex) => {
    const sectorAngle = count === 4
      ? -Math.PI * 0.75 + sectorIndex * Math.PI * 0.5
      : -Math.PI * 0.78 + sectorIndex * Math.PI * 2 / count;
    const cx = Math.cos(sectorAngle) * clusterDistance * 1.12;
    const cy = Math.sin(sectorAngle) * clusterDistance * 0.86;
    const rotation = sectorAngle + Math.PI * 0.5;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    pack.suns.forEach((sun, i) => {
      const local = pack.positions[i]!;
      sun.anchor = point(cx + local.x * cos - local.y * sin, cy + local.x * sin + local.y * cos);
    });
    let standaloneIndex = 0;
    for (const ring of pack.standaloneRings) {
      for (const offset of ring.angles) {
        const standalone = pack.standalones[standaloneIndex]!;
        const angle = sectorAngle + offset;
        standalone.anchor = point(cx + Math.cos(angle) * ring.radius, cy + Math.sin(angle) * ring.radius);
        standaloneIndex += 1;
      }
    }
    const project = pack.sector === null ? null : index.projects.get(pack.sector) ?? null;
    if (project) guides.push({ kind: "cluster", sector: project, cx, cy, radius: pack.outerBound });
  });
  return guides;
}

function layoutPolar(roots: DraftNode[], sectors: (string | null)[], index: DagModelIndex): StarMapSectorGuide[] {
  const count = sectors.length;
  const gap = count > 1 ? 0.12 : 0;
  const available = Math.PI * 2 - gap * count;
  let currentAngle = -Math.PI * 0.85;
  const guides: StarMapSectorGuide[] = [];
  for (const sector of sectors) {
    const span = available / count;
    const startAngle = currentAngle, endAngle = currentAngle + span;
    currentAngle = endAngle + gap;
    const sectorRoots = roots.filter((root) => root.projectId === sector);
    const suns = sectorRoots.filter((root) => root.children.length > 0);
    const standalones = sectorRoots.filter((root) => root.children.length === 0);
    suns.forEach((sun, i) => {
      const angle = startAngle + span * (0.15 + 0.70 * ((i + 0.5) / Math.max(1, suns.length)));
      sun.anchor = point(Math.cos(angle) * 480, Math.sin(angle) * 480);
    });
    const midAngle = (startAngle + endAngle) * 0.5;
    const standaloneArc = count === 1 && suns.length === 0 ? Math.PI * 2 : span * 0.76;
    const standaloneRings = packStandaloneRings(
      standalones.length, count === 1 && suns.length === 0 ? minimumRootSpacing : 210, standaloneArc,
    );
    let standaloneIndex = 0;
    for (const ring of standaloneRings) {
      for (const offset of ring.angles) {
        const standalone = standalones[standaloneIndex]!;
        const angle = midAngle + offset;
        standalone.anchor = point(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
        standaloneIndex += 1;
      }
    }
    const outerStandaloneRadius = standaloneRings.length ? standaloneRings[standaloneRings.length - 1]!.radius : 0;
    const project = sector === null ? null : index.projects.get(sector) ?? null;
    if (project) guides.push({
      kind: "sector", sector: project,
      start: startAngle, end: endAngle, mid: midAngle,
      innerR: count === 1 && suns.length === 0 ? Math.max(0, minimumRootSpacing - 36) : 150,
      outerR: Math.max(740, outerStandaloneRadius + 36),
    });
  }
  return guides;
}

function freezeTree(node: DraftNode): StarMapNode {
  for (const child of node.children) freezeTree(child as DraftNode);
  Object.freeze(node.anchor);
  Object.freeze(node.childrenIds);
  Object.freeze(node.children);
  return Object.freeze(node);
}

function buildEdges(index: DagModelIndex, visible: ReadonlySet<string>): StarMapEdge[] {
  const edges: StarMapEdge[] = [];
  for (const dependency of index.dependencies) {
    if (!dependency.id.startsWith("manual:") || dependency.source === dependency.target ||
      !visible.has(dependency.source) || !visible.has(dependency.target)) continue;
    edges.push({ id: dependency.id, source: dependency.source, target: dependency.target, kind: "manual" });
  }
  const mentionDirections = new Set(index.weakEdges
    .filter((edge) => edge.kind === "mention" && visible.has(edge.from) && visible.has(edge.to))
    .map((edge) => `${edge.from}->${edge.to}`));
  for (const edge of index.weakEdges) {
    if (edge.from === edge.to || !visible.has(edge.from) || !visible.has(edge.to)) continue;
    if (edge.kind === "wakeup") {
      edges.push({
        id: `wakeup:${edge.from}:${edge.to}:${edge.untilState ?? "done"}`,
        source: edge.from, target: edge.to, kind: "wakeup", untilState: edge.untilState,
      });
    } else {
      edges.push({
        id: `mention:${edge.from}:${edge.to}:`,
        source: edge.from, target: edge.to, kind: "mention",
        mutual: mentionDirections.has(`${edge.to}->${edge.from}`),
      });
    }
  }
  for (const edge of edges) Object.freeze(edge);
  Object.freeze(edges);
  return edges;
}

export function buildStarMapHierarchy(
  index: DagModelIndex,
  options: { layout: StarMapLayoutMode; showCompleted: boolean },
): StarMapHierarchy {
  const visibleRoots = index.forest.roots.filter((root) => options.showCompleted ||
    (!index.visibility.hiddenRoots.has(root.id) && !index.visibility.hiddenSingles.has(root.id)));
  const order = new Map(index.graph.nodes.map((node, nodeIndex) => [node.id, nodeIndex] as const));
  const roots = visibleRoots.map((root) => createNode(index, order, index.issues.get(root.id)!, null, root.id, 0));
  const sectors = [...new Set(roots.map((root) => root.projectId))].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  const sectorGuides = roots.length === 0 ? [] : options.layout === "constellation"
    ? layoutConstellation(roots, sectors, index)
    : layoutPolar(roots, sectors, index);
  const frozenRoots = roots.map(freezeTree);
  const nodes: StarMapNode[] = [];
  const nodeById = new Map<string, StarMapNode>();
  const visit = (node: StarMapNode) => {
    nodes.push(node);
    nodeById.set(node.id, node);
    node.children.forEach(visit);
  };
  frozenRoots.forEach(visit);
  Object.freeze(frozenRoots);
  Object.freeze(nodes);
  for (const guide of sectorGuides) Object.freeze(guide);
  Object.freeze(sectorGuides);
  return Object.freeze({
    roots: frozenRoots, nodeById, nodes, sectorGuides,
    edges: buildEdges(index, new Set(nodeById.keys())),
  });
}

export function starMapMacroBounds(hierarchy: StarMapHierarchy): StarMapBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const include = (cx: number, cy: number, radius: number) => {
    left = Math.min(left, cx - radius);
    top = Math.min(top, cy - radius);
    right = Math.max(right, cx + radius);
    bottom = Math.max(bottom, cy + radius);
  };
  for (const root of hierarchy.roots) include(root.anchor.x, root.anchor.y, root.domainRadius);
  for (const guide of hierarchy.sectorGuides) {
    if (guide.kind === "cluster") include(guide.cx, guide.cy, guide.radius);
    else include(0, 0, guide.outerR);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : { left: -200, top: -150, right: 200, bottom: 150 };
}

export function nearestStarMapNode(
  nodes: readonly StarMapNode[],
  positions: ReadonlyMap<string, StarMapPoint>,
  cursor: StarMapPoint,
  zoom: number,
): { node: StarMapNode; root: StarMapNode; distance: number } | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let best: { node: StarMapNode; distance: number; score: number; direct: boolean } | null = null;
  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const distance = Math.hypot(cursor.x - position.x, cursor.y - position.y);
    const radius = node.coreRadius * zoom;
    const direct = distance <= radius + 8;
    let score = distance - radius * 0.75;
    if (node.children.length > 0 && distance <= node.domainRadius * zoom * 1.15)
      score = Math.min(score, distance * 0.55);
    const better = !best || (direct !== best.direct ? direct :
      direct && node.depth !== best.node.depth ? node.depth > best.node.depth : score < best.score);
    if (better) best = { node, distance, score, direct };
  }
  if (!best) return null;
  return { node: best.node, root: byId.get(best.node.rootId) ?? best.node, distance: best.distance };
}

function usableViewport(size: { width: number; height: number }, options: StarMapCameraOptions) {
  const left = Math.max(0, options.insets?.left ?? 0), right = Math.max(0, options.insets?.right ?? 0);
  const top = Math.max(0, options.insets?.top ?? 0), bottom = Math.max(0, options.insets?.bottom ?? 0);
  return {
    left, right, top, bottom,
    width: Math.max(0, size.width - left - right),
    height: Math.max(0, size.height - top - bottom),
    centerX: left + Math.max(0, size.width - left - right) * 0.5,
    centerY: top + Math.max(0, size.height - top - bottom) * 0.5,
  };
}

export function fitStarMapCamera(
  bounds: StarMapBounds,
  size: { width: number; height: number },
  options: StarMapCameraOptions = {},
): StarMapViewport {
  const usable = usableViewport(size, options);
  const width = Math.max(0, bounds.right - bounds.left), height = Math.max(0, bounds.bottom - bounds.top);
  const fill = options.fill ?? 1;
  const fit = Math.min(width > 0 ? usable.width * fill / width : Infinity, height > 0 ? usable.height * fill / height : Infinity);
  const zoom = clamp(fit, options.minZoom ?? 0.05, options.maxZoom ?? 4);
  return {
    x: usable.centerX - (bounds.left + bounds.right) * 0.5 * zoom,
    y: usable.centerY - (bounds.top + bounds.bottom) * 0.5 * zoom,
    zoom,
  };
}

export function clampStarMapCamera(
  camera: StarMapViewport,
  bounds: StarMapBounds,
  size: { width: number; height: number },
  options: StarMapCameraOptions = {},
): StarMapViewport {
  const usable = usableViewport(size, options);
  const width = Math.max(0, bounds.right - bounds.left) * camera.zoom;
  const height = Math.max(0, bounds.bottom - bounds.top) * camera.zoom;
  const idealX = usable.centerX - (bounds.left + bounds.right) * 0.5 * camera.zoom;
  const idealY = usable.centerY - (bounds.top + bounds.bottom) * 0.5 * camera.zoom;
  let x: number, y: number;
  if (width <= usable.width) {
    const drift = Math.max(24, (usable.width - width) * 0.5);
    x = clamp(camera.x, idealX - drift, idealX + drift);
  } else {
    x = clamp(camera.x, size.width - usable.right - bounds.right * camera.zoom, usable.left - bounds.left * camera.zoom);
  }
  if (height <= usable.height) {
    const drift = Math.max(24, (usable.height - height) * 0.5);
    y = clamp(camera.y, idealY - drift, idealY + drift);
  } else {
    y = clamp(camera.y, size.height - usable.bottom - bounds.bottom * camera.zoom, usable.top - bounds.top * camera.zoom);
  }
  return { x, y, zoom: camera.zoom };
}

export function starMapMorphAt(
  startedAt: number,
  now: number,
  options: { duration?: number; reducedMotion?: boolean } = {},
): { progress: number; eased: number; done: boolean } {
  if (options.reducedMotion) return { progress: 1, eased: 1, done: true };
  const duration = options.duration ?? 440;
  const progress = duration <= 0
    ? now >= startedAt ? 1 : 0
    : clamp((now - startedAt) / duration, 0, 1);
  const eased = progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) * 0.5;
  return { progress, eased, done: progress === 1 };
}
