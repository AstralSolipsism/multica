import ELK from "elkjs/lib/elk-api.js";
import { layoutDagScene } from "./dag-scene-layout";
import { fallbackDagScene } from "./dag-scene-fallback";
import type { DagSceneRequest, DagSceneResponse } from "./dag-scene-runner";

declare const self: {
  onmessage: ((event: MessageEvent<DagSceneRequest>) => void) | null;
  postMessage: (message: DagSceneResponse) => void;
};

// ELK's supported worker API avoids loading its synchronous factory inside
// WorkerGlobalScope. Prewarming pays compilation before the first line opens.
const engine = new ELK({ workerFactory: () => new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "module" }) });
const ready = engine.layout({ id: "warmup", children: [], layoutOptions: { "elk.algorithm": "layered" } });
// A startup failure is reported with the next request, without an unhandled rejection.
void ready.catch(() => {});
self.onmessage = async ({ data }) => {
  try {
    if (!data.fallback) await ready;
    const start = performance.now();
    const result = data.fallback ? fallbackDagScene(data.input) : await layoutDagScene(data.input, engine);
    self.postMessage({ requestId: data.requestId, result, computeMs: performance.now() - start });
  } catch (error) {
    self.postMessage({ requestId: data.requestId, error: error instanceof Error ? error.message : "DAG layout failed" });
  }
};
