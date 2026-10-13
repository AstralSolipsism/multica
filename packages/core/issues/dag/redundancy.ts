import type { DagDependency, DagTask } from "./model-index";
import { dagIssueFinished } from "./state";

export interface DagDetailedDependency extends DagDependency {
  redundant: boolean;
  /** Every alternative path crosses a finished intermediate waiter. */
  retained: boolean;
  hiddenByDefault: boolean;
}

/** Inheritance is an implicit parent -> child step after a real dependency.
 * It must never imply that a child waits for its parent's own status. */
export function markDagRedundancy(members: readonly DagTask[], edges: readonly DagDependency[], showRedundant = false): DagDetailedDependency[] {
  const positions = new Map(members.map((m, i) => [m.issue.id, i]));
  const adjacency = members.map(() => new Set<number>());
  const direct = members.map(() => new Set<number>());
  const inherited = members.map(() => [] as number[]);
  const finished = members.map((m) => dagIssueFinished(m.issue));
  function detail(edge: DagDependency, redundant: boolean, retained: boolean): DagDetailedDependency {
    return {
      id: edge.id, source: edge.source, target: edge.target, state: edge.state,
      sourceKind: members[positions.get(edge.source)!]?.isFrame ? "frame" : "task",
      targetKind: members[positions.get(edge.target)!]?.isFrame ? "frame" : "task",
      redundant, retained, hiddenByDefault: !showRedundant && redundant && !retained,
    };
  }
  for (let i = 0; i < members.length; i++) {
    const parent = positions.get(members[i]!.parentId ?? "");
    if (parent !== undefined) {
      adjacency[parent]!.add(i);
      inherited[parent]!.push(i);
    }
  }
  // An ended intermediate cannot convey a wait through its own outgoing
  // dependency. Inheritance is different: a done parent's prerequisites still
  // apply to its children, without requiring the parent itself to be open.
  const liveNext = adjacency.map((next, i): Iterable<number> => finished[i] ? inherited[i]! : next);
  for (const edge of edges) {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    if (source === undefined || target === undefined) continue;
    adjacency[source]!.add(target);
    direct[source]!.add(target);
  }
  const indegree = new Uint32Array(members.length);
  for (const next of adjacency) for (const target of next) indegree[target] = indegree[target]! + 1;
  const order: number[] = [];
  for (let i = 0; i < indegree.length; i++) if (indegree[i] === 0) order.push(i);
  for (let cursor = 0; cursor < order.length; cursor++) {
    for (const target of adjacency[order[cursor]!]!) {
      indegree[target] = indegree[target]! - 1;
      if (indegree[target] === 0) order.push(target);
    }
  }
  // A cyclic read can make two alternative paths justify removing each other.
  // Keep every edge until a coherent DAG arrives instead of disconnecting it.
  if (order.length !== members.length) {
    return edges.map((edge) => detail(edge, false, false));
  }
  const rank = new Uint32Array(members.length);
  for (let i = 0; i < order.length; i++) rank[order[i]!] = i;
  // Most production edges span only a few topological positions. Stop a walk
  // at the target's rank instead of materializing their entire transitive
  // closure. Use bitsets when long/dense spans would make those walks costly.
  const words = Math.ceil(members.length / 32);
  let searchSpan = 0;
  for (const targets of direct) {
    if (targets.size < 2) continue;
    let first = members.length;
    for (const target of targets) first = Math.min(first, rank[target]!);
    for (const target of targets) searchSpan += rank[target]! - first;
  }
  const useBits = searchSpan > edges.length * words && members.length * words <= 4_000_000;
  const all = new Uint32Array(useBits ? members.length * words : 0);
  const live = new Uint32Array(useBits ? members.length * words : 0);
  if (useBits) {
    for (let i = order.length - 1; i >= 0; i--) {
      const source = order[i]!, offset = source * words;
      for (const target of adjacency[source]!) {
        const bit = offset + (target >>> 5), from = target * words;
        all[bit] = all[bit]! | (1 << (target & 31));
        for (let word = 0; word < words; word++) all[offset + word] = all[offset + word]! | all[from + word]!;
      }
      for (const target of liveNext[source]!) {
        const bit = offset + (target >>> 5), from = target * words;
        live[bit] = live[bit]! | (1 << (target & 31));
        for (let word = 0; word < words; word++) live[offset + word] = live[offset + word]! | live[from + word]!;
      }
    }
  }
  function alternative(source: number, target: number, liveOnly: boolean): boolean {
    if (useBits) {
      const reachable = liveOnly ? live : all;
      for (const seed of direct[source]!) {
        if (seed !== target &&
          (reachable[seed * words + (target >>> 5)]! & (1 << (target & 31)))) return true;
      }
      return false;
    }
    const seeds = [...direct[source]!].filter((next) => rank[next]! < rank[target]!);
    const seen = new Set([source, ...seeds]);
    for (let cursor = 0; cursor < seeds.length; cursor++) {
      for (const next of (liveOnly ? liveNext : adjacency)[seeds[cursor]!]!) {
        if (next === target) return true;
        if (rank[next]! > rank[target]! || seen.has(next)) continue;
        seen.add(next);
        seeds.push(next);
      }
    }
    return false;
  }
  return edges.map((edge) => {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    const redundant = source !== undefined && target !== undefined && alternative(source, target, false);
    const retained = redundant && edge.state !== "satisfied" && !alternative(source!, target!, true);
    return detail(edge, redundant, retained);
  });
}
