import {
  layoutDagProjection,
  type DagLayoutRequest,
  type DagLayoutResponse,
} from "./dag-layout";

/**
 * Worker entry: Dagre layout off the main thread so a dense re-layout never
 * blocks canvas interaction (OL-38 budget: layout must not occupy the main
 * thread). The host recreates this worker to cancel a stalled layout — Dagre
 * itself has no mid-run abort, and a terminated worker is the only hard stop.
 *
 * `self` is declared structurally: this package compiles against the DOM lib
 * (no WebWorker lib), and the worker global satisfies this shape at runtime.
 */
declare const self: {
  onmessage: ((event: MessageEvent<DagLayoutRequest>) => void) | null;
  postMessage: (message: DagLayoutResponse) => void;
};

self.onmessage = (event) => {
  const { requestId, nodes, edges, direction } = event.data;
  const started = Date.now();
  const positions = layoutDagProjection(nodes, edges, direction);
  const response: DagLayoutResponse = {
    requestId,
    positions,
    elapsedMs: Date.now() - started,
  };
  self.postMessage(response);
};
