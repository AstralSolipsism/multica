import type { DagPoint } from "./dag-layout";
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

/** Split actual collinear overlap into selectable segments. Coincident paths
 * with unrelated endpoints remain separate, even if a third path relates to
 * each of them: relation is not transitively closed. */
export function dagSceneSegments(edges: readonly DagSceneEdge[], routes: DagSceneGeometry["routes"]) {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const raw: DagSceneSegment[] = [];
  for (const edge of edges) {
    const path = routes[edge.id] ?? [];
    for (let i = 1; i < path.length; i++) {
      const start = path[i - 1]!, end = path[i]!;
      if (start.x !== end.x && start.y !== end.y) throw new Error(`Non-orthogonal DAG route: ${edge.id}`);
      if (start.x !== end.x || start.y !== end.y) raw.push({ id: "", start, end, edgeIds: [edge.id] });
    }
  }
  function merge(input: DagSceneSegment[], endpoint: "source" | "target") {
    const groups = new Map<string, DagSceneSegment[]>();
    const output: DagSceneSegment[] = [];
    for (const segment of input) {
      // A shared source trunk must not absorb unrelated target trunks through
      // transitive endpoint relations. Already shared pieces stay intact.
      if (segment.edgeIds.length > 1) { output.push(segment); continue; }
      const edge = byId.get(segment.edgeIds[0]!)!;
      const horizontal = segment.start.y === segment.end.y;
      const coordinate = horizontal ? "x" : "y";
      const key = JSON.stringify([horizontal, horizontal ? segment.start.y : segment.start.x,
        segment.start[coordinate] < segment.end[coordinate], edge[endpoint], edge[`${endpoint}Kind`]]);
      const list = groups.get(key) ?? []; list.push(segment); groups.set(key, list);
    }
    for (const pieces of groups.values()) {
      if (pieces.length === 1) { output.push(pieces[0]!); continue; }
      const first = pieces[0]!, horizontal = first.start.y === first.end.y;
      const coordinate = horizontal ? "x" : "y", forward = first.start[coordinate] < first.end[coordinate];
      const events = new Map<number, { add: DagSceneSegment[]; remove: DagSceneSegment[] }>();
      for (const piece of pieces) {
        const low = Math.min(piece.start[coordinate], piece.end[coordinate]), high = Math.max(piece.start[coordinate], piece.end[coordinate]);
        const start = events.get(low) ?? { add: [], remove: [] }; start.add.push(piece); events.set(low, start);
        const end = events.get(high) ?? { add: [], remove: [] }; end.remove.push(piece); events.set(high, end);
      }
      const stops = [...events.keys()].sort((a, b) => a - b), active = new Set<DagSceneSegment>();
      for (let i = 0; i + 1 < stops.length; i++) {
        const low = stops[i]!, high = stops[i + 1]!, event = events.get(low)!;
        for (const piece of event.remove) active.delete(piece);
        for (const piece of event.add) active.add(piece);
        if (!active.size) continue;
        const p = (value: number) => ({ ...first.start, [coordinate]: value });
        output.push({ id: "", start: p(forward ? low : high), end: p(forward ? high : low), edgeIds: [...new Set([...active].flatMap((s) => s.edgeIds))].sort() });
      }
    }
    return output;
  }
  // Partition only related paths. Unrelated collinear edges introduce no
  // split points, avoiding quadratic geometry growth in dense overlay graphs.
  const segments = merge(merge(raw, "source"), "target");
  segments.forEach((segment, i) => { segment.id = `segment:${i}`; });
  const incident = new Map<string, DagSceneSegment[]>();
  for (const segment of segments) for (const p of [segment.start, segment.end]) {
    const key = pointKey(p), list = incident.get(key) ?? [];
    list.push(segment); incident.set(key, list);
  }
  const junctions: DagSceneJunction[] = [];
  for (const list of incident.values()) {
    const shared = list.filter((s) => s.edgeIds.length > 1);
    for (const trunk of shared) {
      const p = [trunk.start, trunk.end].find((p) => list.every((s) => pointKey(s.start) === pointKey(p) || pointKey(s.end) === pointKey(p)));
      if (!p) continue;
      const related = list.filter((s) => s.edgeIds.some((id) => trunk.edgeIds.includes(id)));
      const rays = new Set(related.map((s) => {
        const end = pointKey(s.start) === pointKey(p) ? s.end : s.start;
        return `${Math.sign(end.x - p.x)},${Math.sign(end.y - p.y)}`;
      }));
      if (rays.size >= 3) {
        junctions.push({ ...p, edgeIds: [...new Set(related.flatMap((s) => s.edgeIds))].sort() });
        break;
      }
    }
  }
  return { segments, junctions };
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
