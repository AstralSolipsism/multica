"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DagLayoutEdgeInput,
  DagLayoutNodeInput,
  DagLayoutGroupInput,
  DagLayoutRequest,
  DagLayoutResponse,
  DagLayoutResult,
} from "./dag-layout";
import type { DagDirection } from "@multica/core/issues/stores/view-store";

export type DagLayoutExecutor = (
  request: DagLayoutRequest,
  onDone: (response: DagLayoutResponse) => void,
) => void;
export interface DagLayoutRunner {
  execute: DagLayoutExecutor;
  terminate: () => void;
}
export interface DagLayoutState<T> {
  snapshot: T | undefined;
  result: DagLayoutResult | null;
  positions: ReadonlyMap<string, { x: number; y: number }> | null;
  direction: DagDirection;
  pending: boolean;
  pendingSince: number | null;
  lastElapsedMs: number | null;
  error: string | null;
  cancel: () => void;
  retry: () => void;
}

function createWorkerRunner(): DagLayoutRunner {
  let worker: Worker | null = null;
  let listener: ((event: MessageEvent<DagLayoutResponse>) => void) | null = null;
  let errorListener: ((event: ErrorEvent) => void) | null = null;
  let activeRequest: number | null = null;
  const stop = () => {
    worker?.terminate();
    worker = null;
    listener = null;
    errorListener = null;
    activeRequest = null;
  };
  return {
    execute(request, onDone) {
      if (activeRequest !== null) stop();
      activeRequest = request.requestId;
      worker ??= new Worker(new URL("./dag-layout-worker.ts", import.meta.url), { type: "module" });
      if (listener) worker.removeEventListener("message", listener);
      if (errorListener) worker.removeEventListener("error", errorListener);
      listener = (event) => {
        if (event.data?.requestId === request.requestId) {
          activeRequest = null;
          onDone(event.data);
        }
      };
      errorListener = (event) =>
        onDone({
          requestId: request.requestId,
          positions: {},
          groups: {},
          routes: {},
          ports: {},
          elapsedMs: 0,
          error: event.message || "DAG worker failed",
        });
      worker.addEventListener("message", listener);
      worker.addEventListener("error", errorListener);
      worker.postMessage(request);
    },
    terminate: stop,
  };
}
let nextRequestId = 1;
export const EMPTY_LAYOUT_NODES: DagLayoutNodeInput[] = [];
export const EMPTY_LAYOUT_EDGES: DagLayoutEdgeInput[] = [];
export const EMPTY_LAYOUT_GROUPS: DagLayoutGroupInput[] = [];

/** The latest complete geometry wins. The worker owns ELK and can be stopped
 * outright; status/title/selection updates never change its topology input. */
export function useDagLayout<T>(
  nodes: DagLayoutNodeInput[],
  edges: DagLayoutEdgeInput[],
  groups: DagLayoutGroupInput[],
  direction: DagDirection,
  runnerFactory: () => DagLayoutRunner = createWorkerRunner,
  snapshot?: T,
): DagLayoutState<T> {
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const runnerRef = useRef<DagLayoutRunner | null>(null);
  runnerRef.current ??= runnerFactory();
  const [revision, setRevision] = useState(0);
  const [committed, setCommitted] = useState<{
    result: DagLayoutResult;
    snapshot: T | undefined;
    direction: DagDirection;
    elapsedMs: number;
  } | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRequest = useRef(0);
  const input = useMemo(
    () => ({ nodes, edges, groups, direction }),
    [nodes, edges, groups, direction],
  );
  useEffect(() => {
    const request: DagLayoutRequest = { ...input, requestId: nextRequestId++ };
    const requestedSnapshot = snapshotRef.current;
    liveRequest.current = request.requestId;
    setError(null);
    if (!request.nodes.length) {
      runnerRef.current?.terminate();
      setPendingSince(null);
      return;
    }
    setPendingSince(Date.now());
    runnerRef.current!.execute(request, (response) => {
      if (response.requestId !== liveRequest.current) return;
      setPendingSince(null);
      if (response.error) {
        setError(response.error);
        return;
      }
      setCommitted({
        result: response,
        snapshot: requestedSnapshot,
        direction: request.direction,
        elapsedMs: response.elapsedMs,
      });
    });
  }, [input, revision]);
  useEffect(
    () => () => {
      liveRequest.current = 0;
      runnerRef.current?.terminate();
    },
    [],
  );
  const positions = useMemo(
    () => (committed ? new Map(Object.entries(committed.result.positions)) : null),
    [committed],
  );
  return {
    snapshot: committed?.snapshot,
    result: committed?.result ?? null,
    positions,
    direction: committed?.direction ?? direction,
    pending: pendingSince !== null,
    pendingSince,
    lastElapsedMs: committed?.elapsedMs ?? null,
    error,
    cancel: () => {
      liveRequest.current = 0;
      runnerRef.current?.terminate();
      setPendingSince(null);
    },
    retry: () => {
      runnerRef.current?.terminate();
      setRevision((r) => r + 1);
    },
  };
}
