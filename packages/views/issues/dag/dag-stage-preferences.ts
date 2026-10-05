import type {
  DagLayoutNodeInput,
  DagLayoutGroupInput,
  DagLayoutEdgeInput,
} from "./dag-layout";

interface StagePreferenceGraph {
  adjacency: Map<string, string[]>;
  boundaryOwners: Map<string, string>;
}

function stageBuckets(
  byId: ReadonlyMap<string, DagLayoutNodeInput>,
  scope: string,
  members: DagLayoutNodeInput[],
  direct: (id: string, scope: string) => string | null,
) {
  const memberStages = new Map(
    members.filter((n) => n.stage != null).map((n) => [n.id, n.stage!]),
  );
  const stages = [...new Set(memberStages.values())].sort((a, b) => a - b);
  const buckets = new Map<number, string[]>();
  if (stages.length < 2) return { stages, buckets };
  for (const n of byId.values()) {
    const unit = direct(n.id, scope);
    const stage = unit ? memberStages.get(unit) : undefined;
    if (stage == null) continue;
    const bucket = buckets.get(stage) ?? [];
    bucket.push(n.id);
    buckets.set(stage, bucket);
  }
  return { stages, buckets };
}

export function buildStagePreferenceGraph(
  byId: Map<string, DagLayoutNodeInput>,
  groups: Map<string, DagLayoutGroupInput>,
  children: Map<string, DagLayoutNodeInput[]>,
  edges: DagLayoutEdgeInput[],
  direct: (id: string, scope: string) => string | null,
): StagePreferenceGraph {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }
  // Analyze all display-only stage preferences together. A preference that
  // participates in a cycle through other task lines must yield to real edges.
  const planned = new Map(
    [...byId.values()].map((n) => [n.id, [...(adjacency.get(n.id) ?? [])]]),
  );
  const boundaryOwners = new Map<string, string>();
  for (const scope of groups.keys()) {
    if (groups.get(scope)?.independent) continue;
    const members = children.get(scope) ?? [];
    const { stages, buckets } = stageBuckets(byId, scope, members, direct);
    for (let i = 1; i < stages.length; i++) {
      const id = `stage-preference:${scope}:${i}`;
      boundaryOwners.set(id, scope);
      planned.set(id, [...(buckets.get(stages[i]!) ?? [])]);
      for (const before of buckets.get(stages[i - 1]!) ?? [])
        planned.get(before)!.push(id);
    }
  }
  return { adjacency: planned, boundaryOwners };
}

export function conflictingStageScopes({
  adjacency,
  boundaryOwners,
}: StagePreferenceGraph): Set<string> {
  const unsafeStages = new Set<string>();
  for (const component of stronglyConnectedComponents(adjacency)) {
    if (component.length < 2) continue;
    for (const item of component) {
      const owner = boundaryOwners.get(item);
      if (owner) unsafeStages.add(owner);
    }
  }
  return unsafeStages;
}

export function stronglyConnectedComponents(
  planned: Map<string, string[]>,
): string[][] {
  // Iterative Kosaraju avoids recursion limits on long task chains.
  const reverse = reverseGraph(planned);
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
    components: string[][] = [];
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
    components.push(component);
  }
  return components;
}

function reverseGraph(
  planned: ReadonlyMap<string, string[]>,
): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const id of planned.keys()) reverse.set(id, []);
  for (const [id, next] of planned)
    for (const target of next) reverse.get(target)?.push(id);
  return reverse;
}
