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
  prepare: () => void;
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
  error: string | null;
  cancel: () => void;
  retry: () => void;
}

export function createWorkerRunner(): DagLayoutRunner {
  let worker: Worker | null = null;
  let active: { requestId: number; onDone: (response: DagLayoutResponse) => void } | null = null;
  let failure: string | null = null;
  const fail = (requestId: number, error: string): DagLayoutResponse => ({
    requestId, positions: {}, groups: {}, routes: {}, ports: {}, elapsedMs: 0, error,
  });
  const stop = () => {
    worker?.terminate();
    worker = null;
    active = null;
    failure = null;
  };
  const prepare = () => {
    if (worker || failure) return;
    try {
      const instance = new Worker(new URL("./dag-layout-worker.ts", import.meta.url), { type: "module" });
      worker = instance;
      instance.addEventListener("message", (event: MessageEvent<DagLayoutResponse>) => {
        if (worker !== instance || !active || event.data?.requestId !== active.requestId) return;
        const pending = active!;
        active = null;
        pending.onDone(event.data);
      });
      instance.addEventListener("error", (event) => {
        if (worker !== instance) return;
        failure = event.message || "DAG worker failed";
        instance.terminate();
        worker = null;
        const pending = active;
        active = null;
        if (pending) pending.onDone(fail(pending.requestId, failure));
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : "DAG worker failed";
    }
  };
  return {
    prepare,
    execute(request, onDone) {
      if (active) stop();
      prepare();
      if (failure) {
        onDone(fail(request.requestId, failure));
        return;
      }
      active = { requestId: request.requestId, onDone };
      worker!.postMessage(request);
    },
    terminate: stop,
  };
}
let nextRequestId = 1;

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
  } | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRequest = useRef(0);
  const hadLayoutInput = useRef(false);
  useEffect(() => {
    runnerRef.current!.prepare();
    return () => { liveRequest.current = 0; runnerRef.current?.terminate(); };
  }, []);
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
      if (hadLayoutInput.current) runnerRef.current?.terminate();
      hadLayoutInput.current = false;
      setPendingSince(null);
      return;
    }
    hadLayoutInput.current = true;
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
      });
    });
  }, [input, revision]);
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
