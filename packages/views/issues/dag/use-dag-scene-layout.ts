"use client";

import { useEffect, useRef, useState } from "react";
import { dagSceneKey, type DagSceneGeometry, type DagScenePlan } from "./dag-scene";
import { createDagSceneRunner, type DagSceneRunner } from "./dag-scene-runner";

/** Scope must include workspace + query identity. Keep the hook mounted across
 * overview/line/focus navigation so its three LRUs and warm workers survive. */
export function useDagSceneLayout<T>(
  scope: string,
  plan: DagScenePlan | null,
  snapshot: T,
  runnerFactory?: () => DagSceneRunner,
) {
  const runner = useRef<DagSceneRunner | null>(null);
  const current = useRef({ plan, snapshot });
  current.current = { plan, snapshot };
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    scope: string; key: string; geometry: DagSceneGeometry | null; plan: DagScenePlan | null;
    snapshot: T; pending: boolean; error: string | null;
  }>({ scope, key: "", geometry: null, plan: null, snapshot, pending: false, error: null });
  const live = useRef<symbol | null>(null);
  const bypassCache = useRef(false);
  const key = plan ? dagSceneKey(plan.input) : "";
  useEffect(() => {
    // Resolve the default inside the effect: a default-parameter reference to
    // the imported factory is re-evaluated per call, and production bundlers
    // may inline the function there — a fresh identity per render would
    // dispose and recreate the workers on every render.
    const instance = (runnerFactory ?? createDagSceneRunner)();
    runner.current = instance;
    instance.prepare("overview");
    return () => { live.current = null; instance.dispose(); runner.current = null; };
  }, [scope, runnerFactory]);
  useEffect(() => {
    const request = Symbol("layout"), requested = current.current;
    live.current = request;
    const force = bypassCache.current;
    bypassCache.current = false;
    if (!requested.plan) {
      setState({ scope, key, geometry: null, plan: null, snapshot: requested.snapshot, pending: false, error: null });
      return;
    }
    setState((old) => old.scope === scope ? { ...old, pending: true, error: null } : { scope, key: "", geometry: null, plan: null, snapshot: requested.snapshot, pending: true, error: null });
    runner.current!.execute(requested.plan.input, (response) => {
      if (live.current !== request) return;
      if (response.error || !response.result) {
        setState((old) => ({ ...old, pending: false, error: response.error ?? "DAG layout failed" }));
        return;
      }
      setState({ scope, key, geometry: response.result, plan: requested.plan, snapshot: requested.snapshot, pending: false, error: null });
    }, force);
  }, [scope, key, revision, runnerFactory]);
  const sameScope = scope === state.scope;
  const matches = sameScope && key === state.key;
  const painted = useRef({ scope, plan: state.plan, snapshot: state.snapshot });
  if (matches) painted.current = { scope, plan, snapshot };
  const previousContent = sameScope && painted.current.scope === scope;
  return {
    geometry: sameScope ? state.geometry : null,
    // Paint fresh titles/statuses against unchanged geometry; while a new
    // topology is pending the last complete scene stays usable.
    plan: matches ? plan : previousContent ? painted.current.plan : null,
    snapshot: matches ? snapshot : previousContent ? painted.current.snapshot : undefined,
    pending: state.pending || (!sameScope && plan !== null),
    error: sameScope ? state.error : null,
    cancel: () => {
      live.current = null;
      if (plan) runner.current?.cancel(plan.input.kind);
      setState((old) => ({ ...old, pending: false }));
    },
    retry: () => { if (plan) runner.current?.cancel(plan.input.kind); bypassCache.current = true; setRevision((value) => value + 1); },
  };
}
