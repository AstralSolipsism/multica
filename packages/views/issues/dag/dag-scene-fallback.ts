import { DAG_GROUP_HEADER_HEIGHT } from "./dag-constants";
import type { DagSceneBox, DagSceneGeometry, DagSceneInput } from "./dag-scene";
import { emptyDagScene, layoutDagIndependent } from "./dag-scene-layout";
import { routeDagOverlays } from "./dag-scene-geometry";
import { stronglyConnectedComponents } from "./dag-stage-preferences";

/** Bounded, deterministic degradation. It runs in a replacement worker after
 * the deadline kills ELK. Group packing sacrifices crossing minimization but
 * preserves membership, endpoint identity and orthogonal routes. */
export function fallbackDagScene(input: DagSceneInput): DagSceneGeometry {
  if (input.grid) return layoutDagIndependent(input);
  const result = emptyDagScene("fallback");
  const entities = new Map([...input.frames, ...input.nodes].map((item) => [item.id, item]));
  const frames = new Set(input.frames.map((f) => f.id));
  const nodes = new Map(input.nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, string[]>();
  for (const entity of entities.values()) {
    const list = children.get(entity.parentId) ?? [];
    list.push(entity.id); children.set(entity.parentId, list);
  }
  const layouts = new Map<string, { box: DagSceneBox; children: Map<string, DagSceneBox> }>();
  const owner = (id: string, scope: string | null) => {
    let entity = entities.get(id);
    while (entity && entity.parentId !== scope) entity = entities.get(entity.parentId ?? "");
    return entity?.id;
  };
  function pack(scope: string | null) {
    const members = children.get(scope) ?? [];
    const adjacency = new Map(members.map((id) => [id, [] as string[]]));
    for (const edge of input.edges) {
      const a = owner(edge.source, scope), b = owner(edge.target, scope);
      if (a && b && a !== b) adjacency.get(a)!.push(b);
    }
    const components = stronglyConnectedComponents(adjacency), componentOf = new Map<string, number>();
    components.forEach((component, i) => component.forEach((id) => componentOf.set(id, i)));
    const ranks = new Array<number>(components.length).fill(0);
    // Kosaraju emits the condensation in source-first order.
    components.forEach((component, i) => {
      for (const id of component) for (const next of adjacency.get(id) ?? []) {
        const target = componentOf.get(next)!;
        if (target !== i) ranks[target] = Math.max(ranks[target]!, ranks[i]! + 1);
      }
    });
    const maxRank = Math.max(0, ...ranks), buckets = new Map<number, string[]>();
    for (const id of members) {
      const entity = entities.get(id)!;
      let rank = ranks[componentOf.get(id)!]!;
      if (scope === null && entity.side) rank += entity.side === "upstream" ? 0 : entity.side === "current" ? maxRank + 1 : (maxRank + 1) * 2;
      if (scope === null && input.kind === "line") rank = entity.side === "upstream" ? 0 : entity.side === "downstream" ? maxRank + 2 : rank + 1;
      const bucket = buckets.get(rank) ?? []; bucket.push(id); buckets.set(rank, bucket);
    }
    let x = 28, height = 0;
    const positions = new Map<string, DagSceneBox>();
    for (const [, ids] of [...buckets].sort(([a], [b]) => a - b)) {
      let y = scope ? DAG_GROUP_HEADER_HEIGHT + 28 : 28, width = 0;
      for (const id of ids) {
        const size = frames.has(id) ? pack(id).box : nodes.get(id)!;
        positions.set(id, { x, y, width: size.width, height: size.height });
        width = Math.max(width, size.width); y += size.height + 28;
      }
      x += width + 80; height = Math.max(height, y);
    }
    const layout = { box: { x: 0, y: 0, width: Math.max(scope ? 680 : 0, x - 52), height: Math.max(scope ? DAG_GROUP_HEADER_HEIGHT + 56 : 0, height) }, children: positions };
    layouts.set(scope ?? "root", layout);
    return layout;
  }
  const root = pack(null);
  function collect(scope: string, x: number, y: number) {
    for (const [id, box] of layouts.get(scope)!.children) {
      const absolute = { ...box, x: x + box.x, y: y + box.y };
      if (frames.has(id)) {
        result.frames[id] = { ...absolute, bands: [], stageMode: "labels" };
        collect(id, absolute.x, absolute.y);
      } else result.nodes[id] = absolute;
      result.ports[id] = { input: { x: absolute.x, y: absolute.y + absolute.height / 2 }, output: { x: absolute.x + absolute.width, y: absolute.y + absolute.height / 2 } };
    }
  }
  collect("root", 0, 0);
  result.width = root.box.width; result.height = root.box.height;
  Object.assign(result, routeDagOverlays(result, input.edges));
  return result;
}
