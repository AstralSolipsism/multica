import type { DagDependencyState } from "@multica/core/issues/dag";
import type { DagPoint, DagSceneGeometry, DagScenePlan, DagSceneSegment } from "./dag-scene";
import { dagOverviewHoverEdges } from "./dag-scene-inputs";
import { routeDagOverlays } from "./dag-scene-geometry";
import type { DagCanvasModel, DagFocusSet } from "./dag-scene-flow";
import { DAG_MOTION_MAX_SEGMENTS, DAG_MOTION_MIN_ZOOM } from "./dag-constants";

/**
 * Stage 10 highlight, bus-selection, motion and culling rules. Everything here
 * is pure: the canvas and edge layer feed plan/geometry/viewport in and get
 * sets back. Two invariants from OL-280 option B:
 *  - node highlighting follows real model dependencies, never geometric bus
 *    connectivity, and lights each dependency's own complete route only;
 *  - clicking a bus selects original dependency IDs, deduplicated.
 */

/** Scene edges touching a node resolve through the current plan (base first,
 *  then satisfied overlays), so hover/selection work with the switch off. */
function sceneEdges(plan: DagScenePlan) {
  return [...plan.input.edges, ...plan.overlays];
}

/** Keep the frames containing lit nodes lit as well — dimming a sub-line
 *  frame while its member stays bright would hide the bright member's box.
 *  The lookup maps are built once for the whole set: O(N·depth), not O(N²). */
export function dagWithAncestorFrames(plan: DagScenePlan, nodeIds: ReadonlySet<string>): Set<string> {
  const nodeById = new Map(plan.input.nodes.map((node) => [node.id, node]));
  const frameById = new Map(plan.input.frames.map((frame) => [frame.id, frame]));
  const out = new Set(nodeIds);
  for (const id of nodeIds) {
    let parentId = nodeById.get(id)?.parentId ?? frameById.get(id)?.parentId ?? null;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const frame = frameById.get(parentId);
      if (!frame) break;
      out.add(frame.id);
      parentId = frame.parentId;
    }
  }
  return out;
}

/** One-click neighborhood: the node's directly connected dependencies, the
 *  cards at their other ends, and those cards' task-line frames. Never walks
 *  further — chaining uses the focus (upstream/downstream) mode. Returns null
 *  when nothing is connected, so an isolated card only gets its brand ring. */
export function dagSceneSelectionSet(plan: DagScenePlan, nodeId: string): DagFocusSet | null {
  const nodeIds = new Set<string>([nodeId]);
  const edgeIds = new Set<string>();
  for (const edge of sceneEdges(plan)) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    edgeIds.add(edge.id);
    nodeIds.add(edge.source === nodeId ? edge.target : edge.source);
  }
  if (!edgeIds.size) return null;
  return { nodeIds: dagWithAncestorFrames(plan, nodeIds), edgeIds };
}

/** Original dependency IDs running through one or more bus segments,
 *  deduplicated in first-seen order (OL-280: segment membership resolves
 *  through the current plan, never a cached status). */
export function dagBusDependencyIds(
  segmentEdgeIds: readonly string[],
  plan: DagScenePlan,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edgeId of segmentEdgeIds) {
    const rawIds = plan.dependencyIds[edgeId] ?? plan.overlayDependencyIds[edgeId];
    if (!rawIds) continue;
    for (const id of rawIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Scene edges carrying at least one of the given original dependencies — the
 *  bus selection's highlight set, each painted along its own full route. */
export function dagDependencyEdgeIds(
  plan: DagScenePlan,
  dependencyIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const edge of sceneEdges(plan)) {
    const rawIds = plan.dependencyIds[edge.id] ?? plan.overlayDependencyIds[edge.id];
    if (rawIds?.some((id) => dependencyIds.has(id))) out.add(edge.id);
  }
  return out;
}

// ---- Motion ---------------------------------------------------------------

export type DagEdgeMotion = "flow" | "breathe" | null;

/** Motion per dependency state (OL-183 §4): advancing edges carry dots
 *  flowing downstream, cancelled blockers breathe slowly. */
export function dagStateMotion(state: DagDependencyState): DagEdgeMotion {
  if (state === "advancing") return "flow";
  if (state === "cancelled-blocking") return "breathe";
  return null;
}

export interface DagMotionCandidate {
  id: string;
  edgeIds: string[];
}

/** Hard motion gates: system reduced motion, or zoom below 50%. */
export function dagMotionAllowed(zoom: number, reducedMotion: boolean): boolean {
  return !reducedMotion && zoom >= DAG_MOTION_MIN_ZOOM;
}

/** Which visible segments may animate. Hard stops: system reduced motion, or
 *  zoom below 50%. Over the ~60-segment budget only the selected chain keeps
 *  moving (nothing animates with no selection), and even that chain is
 *  truncated to the budget in candidate order. */
export function dagMotionSegments(params: {
  candidates: readonly DagMotionCandidate[];
  highlightedEdgeIds: ReadonlySet<string> | null;
  zoom: number;
  reducedMotion: boolean;
}): Set<string> {
  const { candidates, highlightedEdgeIds, zoom, reducedMotion } = params;
  if (!dagMotionAllowed(zoom, reducedMotion)) return new Set();
  if (candidates.length <= DAG_MOTION_MAX_SEGMENTS)
    return new Set(candidates.map((candidate) => candidate.id));
  const kept = new Set<string>();
  if (highlightedEdgeIds) {
    for (const candidate of candidates) {
      if (kept.size >= DAG_MOTION_MAX_SEGMENTS) break;
      if (candidate.edgeIds.some((edgeId) => highlightedEdgeIds.has(edgeId))) kept.add(candidate.id);
    }
  }
  return kept;
}

/** Direction of a bus interval along a traversing edge's ordered route: 1 when
 *  the route walks the segment from start to end, -1 when it walks it
 *  backwards. Segment coordinates never encode direction (OL-280), so flow
 *  dots need this to move downstream. */
export function dagSegmentFlowDirection(
  route: readonly DagPoint[],
  segment: Pick<DagSceneSegment, "start" | "end">,
): 1 | -1 {
  const mid = { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 };
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (!length2) continue;
    const t = ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / length2;
    if (t < -0.001 || t > 1.001) continue;
    const offX = mid.x - (a.x + t * dx);
    const offY = mid.y - (a.y + t * dy);
    if (offX * offX + offY * offY > 1) continue;
    const along = dx * (segment.end.x - segment.start.x) + dy * (segment.end.y - segment.start.y);
    return along >= 0 ? 1 : -1;
  }
  return 1;
}

// ---- Overview hover overlays ------------------------------------------------

export interface DagHoverOverlay {
  /** Every scene edge the hovered card touches (base + satisfied subsets), for
   *  the highlight set. */
  edgeIds: Set<string>;
  /** Cards at the other ends of those edges — they stay lit too. */
  nodeIds: Set<string>;
  /** Original dependency IDs per edge (the satisfied subset), for display
   *  counts and styles that never double-count a mixed bundle. */
  dependencyIds: Record<string, string[]>;
  /** Satisfied bundles with no base route, routed as overlay-only geometry.
   *  Mixed bundles keep their existing route (never painted or counted
   *  twice — `satisfiedByCard` overlaps the bundle's sourceEdgeIds there). */
  routes: Record<string, DagPoint[]>;
}

/** A simplified card below the readability zoom (OL-183 §7): the DOM node
 *  stays as a transparent interaction shell, the visual is one rect painted
 *  by the edge layer (hundreds of blocks cost a handful of path elements). */
export interface DagGhostBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "overview" | "task" | "frame" | "external";
  /** Overview cards keep their project color strip as the only landmark. */
  color: string | null;
  dashed: boolean;
}

/** Hover/focus on an overview card additionally surfaces its satisfied
 *  inter-line dependencies without a layout pass (OL-183 §2, Stage 8 router). */
export function dagOverviewHoverOverlay(
  model: DagCanvasModel,
  geometry: DagSceneGeometry,
  cardId: string,
): DagHoverOverlay | null {
  if (model.kind !== "overview") return null;
  const hoverEdges = dagOverviewHoverEdges(model.overview, cardId);
  if (!hoverEdges.length) return null;
  const missing = hoverEdges.filter(({ edge }) => !geometry.routes[edge.id]).map(({ edge }) => edge);
  const routed = missing.length ? routeDagOverlays(geometry, missing) : { routes: {} };
  return {
    edgeIds: new Set(hoverEdges.map(({ edge }) => edge.id)),
    nodeIds: new Set(hoverEdges.flatMap(({ edge }) => [edge.source, edge.target])),
    dependencyIds: Object.fromEntries(hoverEdges.map(({ edge, dependencyIds }) => [edge.id, dependencyIds])),
    routes: routed.routes,
  };
}

// ---- Viewport culling --------------------------------------------------------

export interface DagVisibleBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Flow-coordinate rectangle the viewport shows, padded so partially visible
 *  routes and cards at the edge still paint. */
export function dagVisibleBounds(
  transform: readonly [number, number, number],
  size: { width: number; height: number },
  margin = 80,
): DagVisibleBounds | null {
  const [tx, ty, zoom] = transform;
  if (!zoom || size.width <= 0 || size.height <= 0) return null;
  return {
    x0: -tx / zoom - margin,
    y0: -ty / zoom - margin,
    x1: (size.width - tx) / zoom + margin,
    y1: (size.height - ty) / zoom + margin,
  };
}

function boundsIntersect(
  bounds: DagVisibleBounds,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return x1 >= bounds.x0 && x0 <= bounds.x1 && y1 >= bounds.y0 && y0 <= bounds.y1;
}

/** Segments are axis-aligned, so their endpoints are their bounding box. */
export function dagSegmentVisible(
  segment: Pick<DagSceneSegment, "start" | "end">,
  bounds: DagVisibleBounds,
): boolean {
  return boundsIntersect(
    bounds,
    Math.min(segment.start.x, segment.end.x),
    Math.min(segment.start.y, segment.end.y),
    Math.max(segment.start.x, segment.end.x),
    Math.max(segment.start.y, segment.end.y),
  );
}

export function dagRouteVisible(route: readonly DagPoint[], bounds: DagVisibleBounds): boolean {
  if (route.length < 2) return false;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const point of route) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  return boundsIntersect(bounds, x0, y0, x1, y1);
}

export function dagPointVisible(point: DagPoint, bounds: DagVisibleBounds): boolean {
  return point.x >= bounds.x0 && point.x <= bounds.x1 && point.y >= bounds.y0 && point.y <= bounds.y1;
}

/** Quantization grid for the culling key: pan/zoom only re-renders the edge
 *  layer when the visible window crosses a grid line. */
const DAG_CULL_GRID = 160;

/** A primitive key of the quantized visible window, for store selectors whose
 *  result must stay referentially stable between grid crossings. The visible
 *  window itself always uses the REAL zoom (dividing the translate by a
 *  floored zoom shifts it for negative pans); the floored zoom only sets the
 *  cell size, so cells stay ~160 screen px and the key always over-covers.
 *  The key carries its cell size so `dagCullBounds` can scale back. */
export function dagCullBoundsKey(
  transform: readonly [number, number, number],
  size: { width: number; height: number },
): string {
  const [, , zoom] = transform;
  if (!zoom || size.width <= 0 || size.height <= 0) return "";
  const cell = DAG_CULL_GRID / Math.max(0.05, Math.floor(zoom * 5) / 5);
  const bounds = dagVisibleBounds(transform, size, 80 / zoom);
  if (!bounds) return "";
  return [
    Math.floor(bounds.x0 / cell),
    Math.floor(bounds.y0 / cell),
    Math.ceil(bounds.x1 / cell),
    Math.ceil(bounds.y1 / cell),
    cell,
  ].join(",");
}

export function dagCullBounds(key: string): DagVisibleBounds | null {
  if (!key) return null;
  const [x0, y0, x1, y1, cell] = key.split(",").map(Number);
  return {
    x0: x0! * cell!,
    y0: y0! * cell!,
    x1: x1! * cell!,
    y1: y1! * cell!,
  };
}
