import ELK from "elkjs/lib/elk-api.js";
import { buildDagSceneGraph, layoutDagScene } from "./dag-scene-layout";
import { DAG_NODE_WIDTH, DAG_NODE_HEIGHT } from "./dag-constants";
import { fallbackDagScene } from "./dag-scene-fallback";
import type { DagSceneRequest, DagSceneResponse } from "./dag-scene-runner";

declare const self: {
  name: string;
  onmessage: ((event: MessageEvent<DagSceneRequest>) => void) | null;
  postMessage: (message: DagSceneResponse) => void;
};

// ELK's supported worker API avoids loading its synchronous factory inside
// WorkerGlobalScope. Prewarming pays compilation before the first line opens.
const engine = new ELK({ algorithms: ["layered"], workerFactory: () => new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "module" }) });
// An empty graph only loads the module: it never initializes the compound,
// simplex or routing phases needed on the first real line. Exercise those
// phases with a small fixed graph while the overview is loading.
const warmNodes = Array.from({ length: 8 }, (_, i) => ({ id: `warm:${i}`, parentId: i < 4 ? "warm:left" : "warm:right", stage: null, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }));
const warmGraph = buildDagSceneGraph({ kind: "line", id: "warmup", nodes: warmNodes,
  frames: [{ id: "warm:root", modelId: "warm:root", parentId: null }, ...["warm:left", "warm:right"].map((id) => ({ id, modelId: id, parentId: "warm:root" }))],
  edges: warmNodes.slice(1).map((node, i) => ({ id: `warm:edge:${i}`, source: warmNodes[i]!.id, target: node.id, sourceKind: "task", targetKind: "task" })),
}).graph;
// The flat overview does not use compound processing. Making it wait for a
// compound warmup adds work to the initial screen without helping that scene.
const ready = self.name === "overview" ? Promise.resolve() : engine.layout(warmGraph);
// A startup failure is reported with the next request, without an unhandled rejection.
void ready.catch(() => {});
self.onmessage = async ({ data }) => {
  try {
    if (!data.fallback) await ready;
    const start = performance.now();
    let elkMs = 0;
    const measuredEngine: Pick<typeof engine, "layout"> = { async layout(graph, options) {
      const started = performance.now();
      try { return await engine.layout(graph, options); } finally { elkMs += performance.now() - started; }
    } };
    const result = data.fallback ? fallbackDagScene(data.input) : await layoutDagScene(data.input, measuredEngine);
    self.postMessage({ requestId: data.requestId, result, computeMs: performance.now() - start, elkMs });
  } catch (error) {
    self.postMessage({ requestId: data.requestId, error: error instanceof Error ? error.message : "DAG layout failed" });
  }
};
