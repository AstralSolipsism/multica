import ELK from "elkjs/lib/elk-api.js";
import { layoutDagProjection, type DagLayoutRequest, type DagLayoutResponse } from "./dag-layout";

declare const self: {
  onmessage: ((event: MessageEvent<DagLayoutRequest>) => void) | null;
  postMessage: (message: DagLayoutResponse) => void;
};

// Keep the orchestration off the UI thread and use ELK's supported worker API.
// Its bundled synchronous factory detects a native WorkerGlobalScope and cannot
// be nested directly. The browser owns the lifetime of this child worker.
const engine = new ELK({
    workerFactory: () =>
      new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "module" }),
  });

self.onmessage = async (event) => {
  const { requestId, nodes, edges, groups, direction } = event.data;
  try {
    const result = await layoutDagProjection(nodes, edges, direction, groups, engine);
    self.postMessage({ ...result, requestId });
  } catch (error) {
    self.postMessage({
      requestId,
      positions: {},
      groups: {},
      routes: {},
      ports: {},
      error: error instanceof Error ? error.message : "DAG layout failed",
    });
  }
};
