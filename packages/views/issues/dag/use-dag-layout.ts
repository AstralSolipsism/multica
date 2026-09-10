"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DagLayoutEdgeInput,
  DagLayoutNodeInput,
  DagLayoutRequest,
  DagLayoutResponse,
} from "./dag-layout";
import type { DagDirection } from "@multica/core/issues/stores/view-store";

/**
 * Owns the layout worker across projection changes.
 *
 * - Every projection/direction change posts ONE request; responses carry the
 *   request id, so a slow answer to a superseded request is discarded and the
 *   last committed positions stay on screen meanwhile.
 * - `cancel()` terminates the worker outright. Dagre cannot abort mid-run and
 *   a worker processes messages serially, so termination is the only way to
 *   stop a stalled dense layout from blocking every later request; the next
 *   execute lazily spawns a fresh worker.
 * - Positions are keyed by node id, so a status/run-only refresh (same
 *   topologyId) never changes this hook's inputs and no layout happens.
 */

export type DagLayoutExecutor = (
  request: DagLayoutRequest,
  onDone: (response: DagLayoutResponse) => void,
) => void;

export interface DagLayoutRunner {
  execute: DagLayoutExecutor;
  /** Hard-stop the in-flight layout (expand-all cancel). */
  terminate: () => void;
}

export interface DagLayoutState {
  /** Top-left positions by node id; null until the first layout lands. */
  positions: ReadonlyMap<string, { x: number; y: number }> | null;
  /** A request is in flight (first load or re-layout after a topology fold). */
  pending: boolean;
  /** When the current request started — drives the >5s cancel affordance. */
  pendingSince: number | null;
  /** Wall time of the last committed layout, surfaced in performance notes. */
  lastElapsedMs: number | null;
  cancel: () => void;
}

function createWorkerRunner(): DagLayoutRunner {
  let worker: Worker | null = null;
  let listener: ((event: MessageEvent<DagLayoutResponse>) => void) | null = null;
  return {
    execute(request, onDone) {
      worker ??= new Worker(new URL("./dag-layout-worker.ts", import.meta.url));
      if (listener) worker.removeEventListener("message", listener);
      listener = (event) => {
        if (event.data?.requestId === request.requestId) onDone(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage(request satisfies DagLayoutRequest);
    },
    terminate() {
      worker?.terminate();
      worker = null;
      listener = null;
    },
  };
}

let nextRequestId = 1;

const EMPTY_LAYOUT_NODES: DagLayoutNodeInput[] = [];
const EMPTY_LAYOUT_EDGES: DagLayoutEdgeInput[] = [];

export function useDagLayout(
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  direction: DagDirection,
  runnerFactory: () => DagLayoutRunner = createWorkerRunner,
): DagLayoutState {
  const runnerRef = useRef<DagLayoutRunner | null>(null);
  runnerRef.current ??= runnerFactory();
  const [positions, setPositions] = useState<DagLayoutState["positions"]>(null);
  const [lastElapsedMs, setLastElapsedMs] = useState<number | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  // Latest-response wins: the ref flips synchronously with each new request,
  // so a stale worker answer can never overwrite a newer layout.
  const liveRequestIdRef = useRef(0);

  const request = useMemo<DagLayoutRequest>(
    () => ({ requestId: nextRequestId++, nodes, edges, direction }),
    [nodes, edges, direction],
  );

  useEffect(() => {
    if (request.nodes.length === 0) return;
    liveRequestIdRef.current = request.requestId;
    setPendingSince(Date.now());
    const onDone = (response: DagLayoutResponse) => {
      if (response.requestId !== liveRequestIdRef.current) return;
      setPendingSince(null);
      setLastElapsedMs(response.elapsedMs);
      setPositions(new Map(Object.entries(response.positions)));
    };
    runnerRef.current!.execute(request, onDone);
  }, [request]);

  // Unmount tears the worker down with the surface.
  useEffect(() => () => runnerRef.current?.terminate(), []);

  return {
    positions,
    pending: pendingSince !== null,
    pendingSince,
    lastElapsedMs,
    cancel: () => {
      runnerRef.current?.terminate();
      setPendingSince(null);
    },
  };
}

export { EMPTY_LAYOUT_NODES, EMPTY_LAYOUT_EDGES };
