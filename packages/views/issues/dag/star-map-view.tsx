"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashKey } from "@tanstack/react-query";
import { AlertTriangle, FilterX, Loader2 } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import type { Viewport } from "@xyflow/react";
import type { IssueTableQuerySpec } from "@multica/core/types";
import {
  buildStarMapHierarchy,
  clampStarMapCamera,
  computeDagFocus,
  computeDagLine,
  createDagModelIndex,
  fitStarMapCamera,
  useDagGraph,
  type StarMapBounds,
  type StarMapViewport,
} from "@multica/core/issues/dag";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useUpdateIssueBlockers } from "@multica/core/issues/blockers";
import { useReducedMotion } from "@multica/core/appearance";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";
import { useIssuePeekActions, useIssuePeekOpen } from "../surface/peek-context";
import { useViewBaseline } from "../surface/view-baseline-context";
import { DagErrorState, graphErrorPolicy } from "./dag-error-state";
import DagSceneCanvas from "./dag-scene-canvas";
import type { DagSceneCanvasApi, DagSceneCanvasProps, DagLocateRequest } from "./dag-scene-canvas";
import { DagBusSelection, type DagBusSelectionItem } from "./dag-selection-bus";
import type { DagSceneGeometry, DagScenePlan } from "./dag-scene";
import { dagLevelFromPlan, type DagLevel } from "./dag-level";
import { dagBusSelectionRows, dagDependencyStates, dagLineWithSatisfiedFilter } from "./dag-scene-flow";
import { starMapFocusScene, starMapLineScene } from "./star-map-scene";
import { dagSceneContentBounds } from "./dag-viewport";
import { useDagSceneLayout } from "./use-dag-scene-layout";
import { StarMapCanvas } from "./star-map-canvas";
import {
  StarMapControls,
  type StarMapFocusIntent,
  type StarMapLayers,
  type StarMapLayoutMode,
  type StarMapScale,
} from "./star-map-controls";
import type { DagViewProps } from "./dag-view";

const UNSUPPORTED_SCOPE_SPEC: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

type StarMapPhase = "orbital" | "entering" | "linear" | "exiting";
type SceneLevel = Exclude<DagLevel, { kind: "overview" }>;
type PaintedTarget = Pick<DagSceneCanvasProps, "level" | "geometry" | "plan"> & {
  model: Extract<DagSceneCanvasProps["model"], { kind: "line" | "focus" }>;
};

interface BlockerWrite {
  source: string;
  target: string;
  remove: boolean;
}

function geometryBounds(geometry: DagSceneGeometry): StarMapBounds | null {
  const rect = dagSceneContentBounds(geometry);
  return rect
    ? { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
    : null;
}

function cameraInsets(peekOpen: boolean) {
  return { left: 28, right: peekOpen ? 548 : 28, top: 64, bottom: 64 };
}

export interface StarMapDagViewProps extends DagViewProps {
  onOpenLegacy: () => void;
}

/** Star Map owns the orbital camera; the existing scene canvas takes over only
 * after the shared ELK geometry and camera have settled. */
export function StarMapDagView({
  spec,
  hasActiveFilters,
  sceneRunnerFactory,
  onOpenLegacy,
}: StarMapDagViewProps) {
  const { t } = useT("issues");
  const { t: tDag } = useT("dag");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const storeApi = useViewStoreApi();
  const baseline = useViewBaseline();
  const peek = useIssuePeekActions();
  const peekOpen = useIssuePeekOpen();
  const reducedMotion = useReducedMotion();
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme !== "dark";
  const supported = spec.scope.kind === "workspace" || spec.scope.kind === "project";
  const safeSpec = supported ? spec : UNSUPPORTED_SCOPE_SPEC;
  const query = useDagGraph(wsId, safeSpec, supported);
  const graph = query.data;
  const index = useMemo(() => graph ? createDagModelIndex(graph) : null, [graph]);
  const showCompleted = useViewStore((s) => s.dagShowCompleted);
  const showSatisfied = useViewStore((s) => s.dagShowSatisfiedDependencies);
  const selectedDependencyIds = useViewStore((s) => s.dagSelectedDependencyIds);
  const [linearLocateRequest, setLinearLocateRequest] = useState<DagLocateRequest | null>(null);
  const [layout, setLayout] = useState<StarMapLayoutMode>("cluster");
  const [intent, setIntent] = useState<StarMapFocusIntent>("line");
  const [edgeLayers, setEdgeLayers] = useState<Omit<StarMapLayers, "completed">>({
    manual: true,
    wakeup: true,
    mention: false,
    stage: true,
  });
  const [orbiting, setOrbiting] = useState(true);
  const [linking, setLinking] = useState(false);
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState<StarMapPhase>("orbital");
  const [sceneLevel, setSceneLevel] = useState<SceneLevel | null>(null);
  const [seed, setSeed] = useState<{ id: string; intent: StarMapFocusIntent } | null>(null);
  const [exitTarget, setExitTarget] = useState<PaintedTarget | null>(null);
  const [exitCamera, setExitCamera] = useState<StarMapViewport | null>(null);
  const [locateRequest, setLocateRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [scaleCommand, setScaleCommand] = useState<{ kind: StarMapScale; nonce: number } | null>(null);
  const [blockerWrite, setBlockerWrite] = useState<BlockerWrite | null>(null);
  const blockerMutation = useUpdateIssueBlockers(wsId, blockerWrite?.target ?? "");
  const [viewportOverride, setViewportOverride] = useState<{ viewport: Viewport; nonce: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasApi = useRef<DagSceneCanvasApi | null>(null);
  const lastTarget = useRef<PaintedTarget | null>(null);

  const hierarchy = useMemo(
    () => index ? buildStarMapHierarchy(index, {
      layout: layout === "cluster" ? "constellation" : "polar",
      // Keep the full tree for near-scene handoff; the canvas applies the
      // completed LOD filter without dropping target cards.
      showCompleted: true,
    }) : null,
    [index, layout],
  );
  const layers = useMemo<StarMapLayers>(() => ({ ...edgeLayers, completed: showCompleted }), [edgeLayers, showCompleted]);

  const sceneDefinition = useMemo<{ model: PaintedTarget["model"]; plan: DagScenePlan } | null>(() => {
    if (!index || !sceneLevel) return null;
    const relations = { wakeup: edgeLayers.wakeup, mention: edgeLayers.mention };
    if (sceneLevel.kind === "focus") {
      const focus = computeDagFocus(index, sceneLevel.issueId, showCompleted);
      return starMapFocusScene(focus, index, relations);
    }
    const line = computeDagLine(index, sceneLevel.lineId);
    if (!line) return null;
    return starMapLineScene(dagLineWithSatisfiedFilter(line, showSatisfied), index, relations);
  }, [index, sceneLevel, showCompleted, showSatisfied, edgeLayers.wakeup, edgeLayers.mention]);
  const canvasModel = sceneDefinition?.model ?? null;
  const plan = sceneDefinition?.plan ?? null;
  const sceneScope = `${wsId}:${hashKey([safeSpec])}:star-map`;
  const scene = useDagSceneLayout(sceneScope, plan, canvasModel, sceneRunnerFactory);
  const currentTarget = useMemo<PaintedTarget | null>(() => {
    if (!scene.geometry || !scene.plan || !scene.snapshot || !sceneLevel) return null;
    const requestedId = sceneLevel.kind === "focus" ? sceneLevel.issueId : sceneLevel.lineId;
    if (scene.plan.input.kind !== sceneLevel.kind || scene.plan.input.id !== requestedId) return null;
    return {
      level: dagLevelFromPlan(scene.plan),
      model: scene.snapshot,
      geometry: scene.geometry,
      plan: scene.plan,
    };
  }, [scene.geometry, scene.plan, scene.snapshot, sceneLevel]);
  if (currentTarget) lastTarget.current = currentTarget;
  const activeTarget = phase === "exiting" ? exitTarget : currentTarget;

  const projectNames = useMemo(
    () => new Map((graph?.projects ?? []).map((project) => [project.id, project.title])),
    [graph],
  );
  const issuesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  );
  const linearBusSelection = useMemo<DagBusSelectionItem[] | null>(() => {
    if (phase !== "linear" || !selectedDependencyIds?.length || !graph || !currentTarget) return null;
    return dagBusSelectionRows({
      dependencyIds: selectedDependencyIds,
      edges: graph.edges,
      issuesById,
      states: dagDependencyStates(currentTarget.model),
      plan: currentTarget.plan,
      showSatisfied,
    });
  }, [phase, selectedDependencyIds, graph, currentTarget, issuesById, showSatisfied]);
  useEffect(() => {
    if (linearBusSelection?.length === 0) storeApi.getState().setDagSelectedDependencyIds(null);
  }, [linearBusSelection, storeApi]);
  useEffect(() => {
    if (!edgeLayers.manual) storeApi.getState().setDagSelectedDependencyIds(null);
  }, [edgeLayers.manual, storeApi]);
  const searchResults = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle || !hierarchy) return [];
    return hierarchy.nodes
      .filter((node) => `${node.issue.identifier} ${node.issue.title}`.toLocaleLowerCase().includes(needle))
      .slice(0, 8)
      .map((node) => ({ id: node.id, identifier: node.issue.identifier, title: node.issue.title }));
  }, [hierarchy, search]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((old) => Math.abs(old.width - rect.width) < 0.5 && Math.abs(old.height - rect.height) < 0.5
        ? old
        : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [query.isPending, graph]);

  useEffect(() => {
    const columns = hierarchy ? [hierarchy.nodes.map((node) => node.id)] : null;
    peek?.publishColumns(columns);
    return () => peek?.publishColumns(null);
  }, [hierarchy, peek]);

  useEffect(() => {
    if (!blockerWrite) return;
    const write = blockerWrite;
    blockerMutation.mutate(
      write.remove ? { remove_blocked_by: [write.source] } : { blocked_by: [write.source] },
      { onSettled: () => setBlockerWrite((current) => current === write ? null : current) },
    );
    // Keep the native hook's target mounted until its mutation has settled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockerWrite]);

  const sceneForSeed = useCallback((issueId: string, nextIntent: StarMapFocusIntent): SceneLevel | null => {
    if (!index) return null;
    const rootId = index.rootOf.get(issueId) ?? issueId;
    const chain = nextIntent === "chain" || !index.forest.children.has(rootId);
    return chain
      ? { kind: "focus", issueId }
      : { kind: "line", lineId: rootId };
  }, [index]);

  const requestScene = useCallback((issueId: string, nextIntent: StarMapFocusIntent) => {
    const next = sceneForSeed(issueId, nextIntent);
    if (!next) return;
    setSeed({ id: issueId, intent: nextIntent });
    setSceneLevel(next);
    setScaleCommand(null);
    setExitTarget(null);
    setPhase("entering");
  }, [sceneForSeed]);

  const exitToOrbit = useCallback(() => {
    const target = currentTarget ?? lastTarget.current;
    if (!target) {
      setPhase("orbital");
      setSceneLevel(null);
      return;
    }
    setExitTarget(target);
    setExitCamera(canvasApi.current?.getViewport() ?? null);
    setPhase("exiting");
  }, [currentTarget]);

  const morphComplete = useCallback((camera: StarMapViewport) => {
    setScaleCommand(null);
    if (phase === "entering") {
      setViewportOverride((old) => ({ viewport: camera, nonce: (old?.nonce ?? 0) + 1 }));
      setPhase("linear");
    } else if (phase === "exiting") {
      setPhase("orbital");
      setSceneLevel(null);
      setExitTarget(null);
      setExitCamera(null);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "linear" || !currentTarget || !size.width || !size.height) return;
    const bounds = geometryBounds(currentTarget.geometry);
    if (!bounds) return;
    const viewport = fitStarMapCamera(bounds, size, {
      insets: cameraInsets(peekOpen), minZoom: 0.05, maxZoom: 1.56, fill: 0.94,
    });
    setViewportOverride((old) => ({ viewport, nonce: (old?.nonce ?? 0) + 1 }));
  }, [phase, currentTarget, peekOpen, size]);

  const viewportConstraint = useCallback((viewport: Viewport) => {
    const target = currentTarget ?? lastTarget.current;
    const bounds = target ? geometryBounds(target.geometry) : null;
    if (!bounds || !size.width || !size.height) return viewport;
    return clampStarMapCamera(viewport, bounds, size, {
      insets: cameraInsets(peekOpen), minZoom: 0.18, maxZoom: 2.2, fill: 0.94,
    });
  }, [currentTarget, peekOpen, size]);

  const openIssue = useCallback((issueId: string) => peek?.open(issueId), [peek]);
  const locateLinearDependency = useCallback((dependencyId: string) => {
    setLinearLocateRequest((old) => ({ dependencyId, nonce: (old?.nonce ?? 0) + 1 }));
  }, []);
  const openExternal = useCallback((group: { id: string; kind: "line" | "issue" }) => {
    setSceneLevel(group.kind === "line" ? { kind: "line", lineId: group.id } : { kind: "focus", issueId: group.id });
    setSeed({ id: group.id, intent: group.kind === "line" ? "line" : "chain" });
    setPhase("linear");
  }, []);
  const changeIntent = useCallback((nextIntent: StarMapFocusIntent) => {
    setIntent(nextIntent);
    if (!seed || phase === "orbital" || phase === "exiting") return;
    const next = sceneForSeed(seed.id, nextIntent);
    if (!next) return;
    setSeed({ id: seed.id, intent: nextIntent });
    setSceneLevel(next);
    if (phase === "entering") setExitTarget(null);
  }, [phase, sceneForSeed, seed]);
  const changeScale = useCallback((kind: StarMapScale) => {
    if (kind !== "linear" && phase !== "orbital") {
      setScaleCommand((old) => ({ kind, nonce: (old?.nonce ?? 0) + 1 }));
      exitToOrbit();
      return;
    }
    if (kind === "linear" && phase === "linear") return;
    setScaleCommand((old) => ({ kind, nonce: (old?.nonce ?? 0) + 1 }));
  }, [exitToOrbit, phase]);
  const locate = useCallback((issueId: string) => {
    setSearch("");
    setLocateRequest((old) => ({ id: issueId, nonce: (old?.nonce ?? 0) + 1 }));
    if (phase !== "orbital") exitToOrbit();
  }, [exitToOrbit, phase]);
  const clearFilters = useCallback(() => {
    const state = storeApi.getState();
    if (baseline) state.resetFiltersTo(baseline.raw);
    else state.clearFilters();
  }, [baseline, storeApi]);

  if (query.isPending) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-faint-foreground" />
        <p className="text-body">{tDag(($) => $.loading)}</p>
      </div>
    );
  }
  if (query.isError && (!graph || graphErrorPolicy(query.error).hideGraph)) {
    return <DagErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!graph) return null;
  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FilterX className="h-10 w-10 text-faint-foreground" />
        <p className="text-body">{hasActiveFilters ? tDag(($) => $.empty_title) : tDag(($) => $.empty_title_unfiltered)}</p>
        <p className="text-caption">{hasActiveFilters ? tDag(($) => $.empty_hint) : tDag(($) => $.empty_hint_unfiltered)}</p>
        {hasActiveFilters && <Button variant="outline" size="sm" className="mt-1" onClick={clearFilters}>{t(($) => $.filtered_empty.clear_button)}</Button>}
      </div>
    );
  }
  if (!index || !hierarchy) return null;

  const scale: StarMapScale = phase === "linear" || phase === "entering"
    ? "linear"
    : scaleCommand?.kind === "meso" || phase === "exiting" ? "meso" : "macro";
  const focusIssue = seed ? index.issues.get(seed.id) : null;
  const status = blockerMutation.error?.message
    ?? (scene.pending ? tDag(($) => $.layout_pending) : scene.error ? tDag(($) => $.layout_error) : undefined);

  return (
    <div
      ref={containerRef}
      className="star-map-view relative flex-1 min-h-0 overflow-hidden bg-[#080a0f] data-[star-map-theme=light]:bg-[#f4f6f9]"
      data-star-map-theme={light ? "light" : "dark"}
      data-star-map-phase={phase}
      onWheelCapture={(event) => {
        if (phase !== "linear" || event.deltaY <= 0) return;
        event.preventDefault();
        event.stopPropagation();
        exitToOrbit();
      }}
    >
      {phase === "linear" && currentTarget ? (
        <div className="absolute inset-0 flex">
          <DagSceneCanvas
          {...currentTarget}
          statusColorOf={catalog.colorOf}
          projectNames={projectNames}
          showSatisfied={showSatisfied}
          focusRequest={null}
          locateRequest={linearLocateRequest}
          relationVisibility={edgeLayers}
          blockerConnection={{
            enabled: linking,
            onConnect: (source, target) => setBlockerWrite({ source, target, remove: false }),
          }}
          onEnterLine={(lineId) => {
            setSceneLevel({ kind: "line", lineId });
            setSeed({ id: lineId, intent: "line" });
          }}
          onOpenIssue={openIssue}
          onExternalJump={openExternal}
          registerCanvasApi={(api) => { canvasApi.current = api; }}
          viewportOverride={viewportOverride}
          viewportConstraint={viewportConstraint}
          embedded
          />
        </div>
      ) : (
        <StarMapCanvas
          hierarchy={hierarchy}
          target={activeTarget}
          phase={phase}
          layers={layers}
          layout={layout}
          intent={intent}
          orbiting={orbiting}
          linking={linking}
          light={light}
          peekOpen={peekOpen}
          reducedMotion={reducedMotion}
          initialCamera={phase === "exiting" ? exitCamera : null}
          locateRequest={locateRequest}
          scaleCommand={scaleCommand}
          onRequestScene={requestScene}
          onMorphComplete={morphComplete}
          onExitToOrbit={exitToOrbit}
          onOpenIssue={openIssue}
          onAddBlocker={(source, target) => setBlockerWrite({ source, target, remove: false })}
          onRemoveBlocker={(source, target) => setBlockerWrite({ source, target, remove: true })}
        />
      )}

      {phase === "linear" && linearBusSelection && linearBusSelection.length > 0 && (
        <div className="absolute left-1/2 top-16 z-30 min-w-0 -translate-x-1/2 rounded-lg border border-border bg-background/90 p-1.5 shadow-lg backdrop-blur-md">
          <DagBusSelection
            items={linearBusSelection}
            onLocate={locateLinearDependency}
            onOpenIssue={openIssue}
          />
        </div>
      )}

      <StarMapControls
        layout={layout}
        onLayoutChange={setLayout}
        intent={intent}
        onIntentChange={changeIntent}
        scale={scale}
        onScaleChange={changeScale}
        orbiting={orbiting}
        onToggleOrbit={() => setOrbiting((value) => !value)}
        linking={linking}
        onToggleLinking={() => setLinking((value) => !value)}
        layers={layers}
        onToggleLayer={(key) => {
          if (key === "completed") storeApi.getState().toggleDagShowCompleted();
          else setEdgeLayers((old) => ({ ...old, [key]: !old[key] }));
        }}
        query={search}
        onQueryChange={setSearch}
        results={searchResults}
        onLocate={locate}
        rootLabel={tDag(($) => $.star_map.node_count, { count: hierarchy.roots.length })}
        focusLabel={focusIssue ? `${focusIssue.identifier} · ${focusIssue.title}` : undefined}
        onHome={() => changeScale("macro")}
        onOpenLegacy={onOpenLegacy}
        status={status}
      />

      {scene.error && (
        <div className="absolute inset-x-4 top-16 z-30 flex items-center gap-2 rounded-lg border border-warning/30 bg-background/90 px-3 py-2 text-caption text-warning" role="alert">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{tDag(($) => $.layout_error)}</span>
          <Button size="sm" variant="ghost" onClick={scene.retry}>{tDag(($) => $.error_retry)}</Button>
          <Button size="sm" variant="ghost" onClick={exitToOrbit}>{tDag(($) => $.back_to_overview)}</Button>
        </div>
      )}
      {query.isError && (
        <div className="absolute inset-x-4 top-16 z-30 flex items-center gap-2 rounded-lg border border-warning/30 bg-background/90 px-3 py-2 text-caption text-warning" role="alert">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{tDag(($) => $.stale_banner, { time: graph.capturedAt })}</span>
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>{tDag(($) => $.error_retry)}</Button>
        </div>
      )}
    </div>
  );
}
