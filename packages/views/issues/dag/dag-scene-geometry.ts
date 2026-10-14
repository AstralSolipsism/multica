import type { DagPoint } from "./dag-scene";
import type { DagSceneEdge, DagSceneGeometry, DagSceneJunction, DagSceneSegment } from "./dag-scene";

const pointKey = (p: DagPoint) => `${p.x},${p.y}`;
export function cleanDagPath(points: DagPoint[]): DagPoint[] {
  const result: DagPoint[] = [];
  for (const point of points) {
    const p = { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 };
    const previous = result.at(-1);
    if (previous && pointKey(previous) === pointKey(p)) continue;
    const before = result.at(-2);
    if (before && previous && ((before.x === previous.x && previous.x === p.x) || (before.y === previous.y && previous.y === p.y))) {
      // Keep reversals (a feedback edge may double back at a boundary).
      if ((previous.x - before.x) * (p.x - previous.x) + (previous.y - before.y) * (p.y - previous.y) >= 0) result.pop();
    }
    result.push(p);
  }
  return result;
}

interface BusLine {
  horizontal: boolean;
  fixed: number;
  events: Map<number, { add: string[]; remove: string[] }>;
}

function collectBusLines(edges: readonly DagSceneEdge[], routes: DagSceneGeometry["routes"]) {
  const lines = new Map<string, BusLine>();
  for (const edge of edges) {
    const path = routes[edge.id] ?? [];
    for (let i = 1; i < path.length; i++) {
      const start = path[i - 1]!;
      const end = path[i]!;
      if (start.x !== end.x && start.y !== end.y) {
        throw new Error(`Non-orthogonal DAG route: ${edge.id}`);
      }
      if (start.x === end.x && start.y === end.y) continue;
      const horizontal = start.y === end.y;
      const coordinate = horizontal ? "x" : "y";
      const fixed = horizontal ? start.y : start.x;
      const key = `${horizontal ? "h" : "v"}:${fixed}`;
      const line: BusLine = lines.get(key) ?? { horizontal, fixed, events: new Map() };
      lines.set(key, line);
      for (const [value, action] of [
        [Math.min(start[coordinate], end[coordinate]), "add"],
        [Math.max(start[coordinate], end[coordinate]), "remove"],
      ] as const) {
        const event = line.events.get(value) ?? { add: [], remove: [] };
        event[action].push(edge.id);
        line.events.set(value, event);
      }
    }
  }
  return [...lines.values()].sort((a, b) =>
    Number(b.horizontal) - Number(a.horizontal) || a.fixed - b.fixed,
  );
}

function splitBusLine(line: BusLine): DagSceneSegment[] {
  const stops = [...line.events.keys()].sort((a, b) => a - b);
  // A feedback route can traverse the same interval more than once. Counts
  // prevent one traversal's end from removing another still-active traversal.
  const active = new Map<string, number>();
  const segments: DagSceneSegment[] = [];
  const point = (value: number) => line.horizontal
    ? { x: value, y: line.fixed }
    : { x: line.fixed, y: value };
  for (let i = 0; i + 1 < stops.length; i++) {
    const low = stops[i]!;
    const event = line.events.get(low)!;
    for (const id of event.remove) {
      const count = active.get(id)! - 1;
      if (count) active.set(id, count);
      else active.delete(id);
    }
    for (const id of event.add) active.set(id, (active.get(id) ?? 0) + 1);
    if (!active.size) continue;
    segments.push({
      id: "",
      start: point(low),
      end: point(stops[i + 1]!),
      edgeIds: [...active.keys()].sort(),
    });
  }
  return segments;
}

function busJunctions(segments: readonly DagSceneSegment[]): DagSceneJunction[] {
  const incident = new Map<string, { point: DagPoint; segments: DagSceneSegment[] }>();
  for (const segment of segments) {
    for (const point of [segment.start, segment.end]) {
      const key = pointKey(point);
      const entry = incident.get(key) ?? { point, segments: [] };
      entry.segments.push(segment);
      incident.set(key, entry);
    }
  }
  const junctions: DagSceneJunction[] = [];
  for (const [key, { point, segments: list }] of incident) {
    const edgeIds = new Set<string>();
    for (const trunk of list.filter((segment) => segment.edgeIds.length > 1)) {
      const related = list.filter((segment) =>
        segment.edgeIds.some((id) => trunk.edgeIds.includes(id)),
      );
      const rays = new Set(related.map((segment) => {
        const end = pointKey(segment.start) === key ? segment.end : segment.start;
        return `${Math.sign(end.x - point.x)},${Math.sign(end.y - point.y)}`;
      }));
      // A crossing without shared route membership is not a connection.
      // Likewise, a two-direction corner on a shared bus is not a junction.
      if (rays.size >= 3) {
        for (const segment of related) for (const id of segment.edgeIds) edgeIds.add(id);
      }
    }
    if (edgeIds.size) junctions.push({ ...point, edgeIds: [...edgeIds].sort() });
  }
  return junctions;
}

/** Render every occupied interval once, with all traversing scene edges.
 * Segment direction is canonical; ordered routes retain each edge's direction
 * for arrows and animation. Sharing a bus never creates a dependency. */
export function dagSceneSegments(edges: readonly DagSceneEdge[], routes: DagSceneGeometry["routes"]) {
  const segments = collectBusLines(edges, routes).flatMap(splitBusLine);
  segments.forEach((segment, i) => { segment.id = `segment:${i}`; });
  return { segments, junctions: busJunctions(segments) };
}

/** Overlay routing deliberately leaves all boxes untouched. Existing mixed
 * bundles reuse their exact route; other edges use shared endpoint stubs and
 * an orthogonal corridor. This also serves the bounded-time fallback. */
export function routeDagOverlays(geometry: DagSceneGeometry, edges: readonly DagSceneEdge[], baseEdges: readonly DagSceneEdge[] = []) {
  const routes: DagSceneGeometry["routes"] = Object.fromEntries(baseEdges.filter((edge) => geometry.routes[edge.id]).map((edge) => [edge.id, geometry.routes[edge.id]!]));
  for (const edge of edges) {
    if (geometry.routes[edge.id]) { routes[edge.id] = geometry.routes[edge.id]!; continue; }
    const start = geometry.ports[edge.source]?.output, end = geometry.ports[edge.target]?.input;
    if (!start || !end) continue;
    const left = start.x + 20, right = end.x - 20;
    if (left <= right) {
      const middle = (left + right) / 2;
      routes[edge.id] = cleanDagPath([start, { x: middle, y: start.y }, { x: middle, y: end.y }, end]);
    } else {
      const top = Math.min(start.y, end.y) - 80;
      routes[edge.id] = cleanDagPath([start, { x: left, y: start.y }, { x: left, y: top }, { x: right, y: top }, { x: right, y: end.y }, end]);
    }
  }
  // Compose base and overlay membership before styling/hit testing, so a
  // satisfied overlay cannot paint over an unsatisfied shared trunk.
  const combined = [...new Map([...baseEdges, ...edges].map((edge) => [edge.id, edge])).values()];
  return { routes, ...dagSceneSegments(combined, routes) };
}
