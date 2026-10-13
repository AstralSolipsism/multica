import { DAG_LAYOUT_DEADLINE_MS } from "./dag-constants";
import { dagSceneKey, type DagSceneGeometry, type DagSceneInput, type DagSceneKind } from "./dag-scene";
import { createDagWorkerChannels } from "./dag-worker-runner";

export interface DagSceneRequest { requestId: number; input: DagSceneInput; fallback?: boolean }
export interface DagSceneResponse { requestId: number; result?: DagSceneGeometry; error?: string; computeMs?: number }
export interface DagSceneRunner {
  prepare: (kind: DagSceneKind) => void;
  execute: (input: DagSceneInput, done: (response: DagSceneResponse) => void, bypassCache?: boolean) => void;
  cancel: (kind: DagSceneKind) => void;
  dispose: () => void;
}

export function createDagSceneRunner({
  workerFactory = () => new Worker(new URL("./dag-scene-worker.ts", import.meta.url), { type: "module" }),
  capacity = 24,
  deadlineMs = DAG_LAYOUT_DEADLINE_MS,
}: { workerFactory?: () => Worker; capacity?: number; deadlineMs?: number } = {}): DagSceneRunner {
  const workers = createDagWorkerChannels<DagSceneRequest, DagSceneResponse>(workerFactory, (requestId, error) => ({ requestId, error }));
  const caches = new Map<DagSceneKind, Map<string, DagSceneGeometry>>();
  const active = new Map<DagSceneKind, { key: string; requestId: number; done: (response: DagSceneResponse) => void }>();
  let nextId = 0;
  function cancel(kind: DagSceneKind) { active.delete(kind); workers.terminate(kind); }
  return {
    prepare: (kind) => workers.prepare(kind),
    execute(input, done, bypassCache = false) {
      const kind = input.kind, key = dagSceneKey(input), pending = active.get(kind);
      if (pending?.key === key && !bypassCache) { pending.done = done; return; }
      if (pending) cancel(kind);
      const requestId = ++nextId, cache = caches.get(kind) ?? new Map<string, DagSceneGeometry>();
      caches.set(kind, cache);
      if (bypassCache) cache.delete(key);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key); cache.set(key, cached);
        done({ requestId, result: cached });
        return;
      }
      const item = { key, requestId, done };
      active.set(kind, item);
      const complete = (response: DagSceneResponse) => {
        if (active.get(kind) !== item) return;
        active.delete(kind);
        if (response.result) {
          cache.set(key, response.result);
          while (cache.size > Math.max(1, capacity)) cache.delete(cache.keys().next().value!);
          if (kind === "overview") { workers.prepare("line"); workers.prepare("focus"); }
        }
        item.done(response);
      };
      workers.execute(kind, { requestId, input }, complete, {
        ms: deadlineMs,
        expired: () => {
          if (active.get(kind) !== item) return;
          workers.execute(kind, { requestId, input, fallback: true }, complete);
        },
      });
    },
    cancel,
    dispose() { active.clear(); workers.terminate(); caches.clear(); },
  };
}
