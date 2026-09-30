import ELK from "elkjs/lib/elk-api.js";
import { layoutDagProjection, type DagLayoutRequest, type DagLayoutResponse } from "./dag-layout";

declare const self: {
  onmessage: ((event: MessageEvent<DagLayoutRequest>) => void) | null;
  postMessage: (message: DagLayoutResponse) => void;
};

// Keep the orchestration off the UI thread and use ELK's supported worker API.
// Its bundled synchronous factory detects a native WorkerGlobalScope and cannot
// be nested directly. The browser owns the lifetime of this child worker.
let engine: InstanceType<typeof ELK> | undefined;
function layoutEngine() {
  return (engine ??= new ELK({
    workerFactory: () =>
      new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "module" }),
  }));
}

self.onmessage = async (event) => {
  const { requestId, nodes, edges, groups, direction } = event.data;
  const started = Date.now();
  try {
    const result = await layoutDagProjection(nodes, edges, direction, groups, layoutEngine());
    self.postMessage({ ...result, requestId, elapsedMs: Date.now() - started });
  } catch (error) {
    self.postMessage({
      requestId,
      positions: {},
      groups: {},
      routes: {},
      ports: {},
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : "DAG layout failed",
    });
  }
};
