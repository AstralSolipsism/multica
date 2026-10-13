import { IssueGraphSchema } from "../../packages/core/api/issue-graph-schemas";
import { createDagModelIndex } from "../../packages/core/issues/dag/model-index";
import { computeDagOverview } from "../../packages/core/issues/dag/overview";
import { computeDagLine, computeDagFocus } from "../../packages/core/issues/dag/detail";
import { dagFocusLayoutInput, dagLineLayoutInput, dagOverviewLayoutInput } from "../../packages/views/issues/dag/dag-scene-inputs";
import { createDagSceneRunner } from "../../packages/views/issues/dag/dag-scene-runner";
import { routeDagOverlays } from "../../packages/views/issues/dag/dag-scene-geometry";
import type { DagSceneInput, DagSceneGeometry, DagScenePlan } from "../../packages/views/issues/dag/dag-scene";

/** Browser harness uses the production worker path, including serialization,
 * worker startup, cancellation, the 3s deadline, fallback and content cache. */
export async function runDagLayoutBenchmark(payload: unknown, bigPayload?: unknown, samples = 10, compareAllEdges = false) {
  const index = createDagModelIndex(IssueGraphSchema.parse(payload));
  const overview = computeDagOverview(index), overviewAll = computeDagOverview(index, { showCompleted: true, showSatisfiedDependencies: true });
  const lines = [...index.lineInputs.values()].filter((line) => index.forest.children.has(line.id)).sort((a, b) => b.members.length - a.members.length);
  const line = computeDagLine(index, lines[0]!.id)!;
  let focus = computeDagFocus(index, line.tasks[0]!.issue.id);
  let distance = Infinity;
  for (const task of index.graph.nodes) {
    if (index.visibility.hiddenRoots.has(index.rootOf.get(task.id)!) || index.forest.children.has(task.id)) continue;
    const candidate = computeDagFocus(index, task.id);
    const count = candidate.groups.reduce((sum, group) => sum + group.tasks.length, 0);
    if (Math.abs(count - 25) < distance) { focus = candidate; distance = Math.abs(count - 25); }
    if (!distance) break;
  }
  const runner = createDagSceneRunner();
  const eventLoopDelays: number[] = [];
  let previousTick = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now(); eventLoopDelays.push(Math.max(0, now - previousTick - 16)); previousTick = now;
  }, 16);
  const execute = (input: DagSceneInput) => new Promise<{ geometry: DagSceneGeometry; computeMs?: number }>((resolve, reject) => runner.execute(input, (response) => response.result ? resolve({ geometry: response.result, computeMs: response.computeMs }) : reject(new Error(response.error))));
  const artifacts: Record<string, { input: DagSceneInput; geometry: DagSceneGeometry; labels: Record<string, string> }> = {};
  const labels = Object.fromEntries(index.graph.nodes.map((node) => [node.id, `${node.identifier} ${node.title}`]));
  for (const card of overviewAll.cards) labels[card.id] = card.issue ? `${card.issue.identifier} ${card.issue.title}` : "Independent tasks";
  function artifact(name: string, plan: DagScenePlan, geometry: DagSceneGeometry) {
    for (const frame of plan.input.frames) labels[frame.id] = labels[frame.modelId] ?? frame.modelId;
    artifacts[name] = { input: plan.input, geometry, labels: { ...labels } };
  }
  async function measure(name: string, plan: DagScenePlan, count = samples) {
    const warmups = 5;
    const coldStart = performance.now(), first = await execute(plan.input), firstMs = performance.now() - coldStart;
    artifact(name, plan, first.geometry);
    const times: number[] = [], computeTimes: number[] = [], qualities: string[] = [];
    for (let i = 0; i < count + warmups; i++) {
      const start = performance.now();
      const result = await execute({ ...plan.input, id: `${plan.input.id}:sample:${i}` });
      const elapsed = performance.now() - start;
      if (i >= warmups) { times.push(elapsed); computeTimes.push(result.computeMs!); qualities.push(result.geometry.quality); }
    }
    times.sort((a, b) => a - b);
    computeTimes.sort((a, b) => a - b);
    const cacheInput = { ...plan.input, id: `${plan.input.id}:sample:${count + warmups - 1}` };
    const cacheStart = performance.now(); await execute(cacheInput); const cacheMs = performance.now() - cacheStart;
    return { nodes: plan.input.nodes.length, frames: plan.input.frames.length, edges: plan.input.edges.length, overlays: plan.overlays.length, firstMs, p50: times[Math.floor(times.length / 2)], p95: times[Math.ceil(times.length * 0.95) - 1], max: times.at(-1), compute: { first: first.computeMs, p50: computeTimes[Math.floor(computeTimes.length / 2)], p95: computeTimes[Math.ceil(computeTimes.length * 0.95) - 1], max: computeTimes.at(-1) }, samples: count, warmups, cacheMs, quality: first.geometry.quality, warmQualities: [...new Set(qualities)] };
  }
  try {
    const timings: Record<string, unknown> = {};
    timings.overview = await measure("overview", dagOverviewLayoutInput(overview));
    timings.line = await measure("line", dagLineLayoutInput(line));
    timings.focus = await measure("focus", dagFocusLayoutInput(focus));
    const allPlan = dagOverviewLayoutInput(overviewAll);
    timings.overviewAll = await measure("overview-all", allPlan);
    const geometry = artifacts["overview-all"]!.geometry;
    const start = performance.now();
    const overlays = routeDagOverlays(geometry, allPlan.overlays, allPlan.input.edges);
    timings.satisfiedOverlayMs = performance.now() - start;
    artifacts["overview-all"]!.geometry = { ...geometry, ...overlays };
    // Compare tuned ELK with every dependency participating. The same deadline
    // applies, so this diagnostic cannot strand a worker for minutes.
    if (compareAllEdges) timings.overviewAllEdges = await measure("overview-all-elk", { ...allPlan, input: { ...allPlan.input, id: "all-edges", edges: [...allPlan.input.edges, ...allPlan.overlays] }, overlays: [] }, Math.min(3, samples));
    if (bigPayload) {
      const bigIndex = createDagModelIndex(IssueGraphSchema.parse(bigPayload));
      const largest = [...bigIndex.lineInputs.values()].sort((a, b) => b.members.length - a.members.length)[0]!;
      timings.bigLine = await measure("big-line", dagLineLayoutInput(computeDagLine(bigIndex, largest.id)!));
    }
    return { dataset: { tasks: index.graph.nodes.length, dependencies: index.graph.edges.length, largestLine: line.id, largestLineMembers: lines[0]!.members.length, focusId: focus.issueId }, timings, mainThread: { heartbeatCount: eventLoopDelays.length, maxDelayMs: Math.max(0, ...eventLoopDelays) }, artifacts };
  } finally { clearInterval(heartbeat); runner.dispose(); }
}

export async function renderDagSnapshots(payload: unknown, identifiers: string[], focusIdentifier?: string) {
  const index = createDagModelIndex(IssueGraphSchema.parse(payload)), runner = createDagSceneRunner();
  const results: Record<string, { input: DagSceneInput; geometry: DagSceneGeometry; labels: Record<string, string> }> = {};
  const labels = Object.fromEntries(index.graph.nodes.map((n) => [n.id, `${n.identifier} ${n.title}`]));
  async function draw(name: string, plan: DagScenePlan) {
    const geometry = await new Promise<DagSceneGeometry>((resolve, reject) => runner.execute(plan.input, (response) => response.result ? resolve(response.result) : reject(new Error(response.error))));
    const text = { ...labels };
    for (const frame of plan.input.frames) text[frame.id] = text[frame.modelId] ?? frame.modelId;
    for (const node of plan.input.nodes) if (node.side && !text[node.id]) {
      const parts = JSON.parse(node.id) as string[];
      text[node.id] = `${node.side}: ${text[parts[2]!] ?? parts[2]}`;
    }
    results[name] = { input: plan.input, geometry, labels: text };
  }
  try {
    for (const identifier of identifiers) {
      const issue = index.graph.nodes.find((n) => n.identifier === identifier);
      if (!issue) throw new Error(`Missing issue ${identifier}`);
      const model = computeDagLine(index, issue.id);
      if (!model) throw new Error(`Not a task line: ${identifier}`);
      await draw(identifier, dagLineLayoutInput(model));
    }
    if (focusIdentifier) {
      const issue = index.graph.nodes.find((n) => n.identifier === focusIdentifier);
      if (!issue) throw new Error(`Missing focus ${focusIdentifier}`);
      await draw(`focus-${focusIdentifier}`, dagFocusLayoutInput(computeDagFocus(index, issue.id, true)));
    }
    return results;
  } finally { runner.dispose(); }
}
