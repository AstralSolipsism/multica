"use client";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashKey } from "@tanstack/react-query";
import { AlertTriangle, FilterX, Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import type { IssueGraphNode } from "@multica/core/api";
import type { IssueTableQuerySpec } from "@multica/core/types";
import {
  DAG_INDEPENDENT_GROUP,
  useDagModels,
  type DagIssue,
  type DagModelRequest,
  type DagTask,
} from "@multica/core/issues/dag";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useViewBaseline } from "../surface/view-baseline-context";
import { once } from "../surface/once";
import {
  DAG_OVERVIEW_LEVEL,
  dagAutoEnterLineId,
  dagExternalJumpTarget,
  dagLevelFromLineId,
  dagLevelViewportKey,
  dagOverviewCardIdForLine,
} from "./dag-level";
import { useDagSceneLayout } from "./use-dag-scene-layout";
import type { DagSceneRunner } from "./dag-scene-runner";
import {
  dagLineWithSatisfiedFilter,
  dagDependencyStates,
  dagSceneEdgeDisplay,
  resolveDagSelection,
  type DagCanvasModel,
} from "./dag-scene-flow";
import {
  dagIndependentLayoutInput,
  dagLineLayoutInput,
  dagOverviewLayoutInput,
} from "./dag-scene-inputs";
import { DagToolbar } from "./dag-toolbar";
import { DagErrorState, graphErrorPolicy } from "./dag-error-state";
import type { DagSceneCanvasApi } from "./dag-scene-canvas";

const loadDagCanvas = once(() => import("./dag-scene-canvas"));
const DagSceneCanvas = lazy(loadDagCanvas);

/** Mirrors useDagSurfaceGraph: DAG scopes are workspace/project only, and the
 *  graph request normalizer throws on anything else during render. */
const UNSUPPORTED_SCOPE_SPEC: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

export interface DagViewProps {
  /** The surface's table query spec; the DAG fetches the graph for it. */
  spec: IssueTableQuerySpec;
  hasActiveFilters: boolean;
  /** Test seam: replaces the Web Worker scene layout runner. */
  sceneRunnerFactory?: () => DagSceneRunner;
}

function toDagIssue(node: IssueGraphNode): DagIssue {
  const run = node.runSummary;
  return {
    ...node,
    runSummary: run
      ? {
          queued: run.queued,
          dispatched: run.dispatched,
          running: run.running,
          waitingLocalDirectory: run.waitingLocalDirectory,
        }
      : null,
  };
}

export function DagView({
  spec,
  hasActiveFilters,
  sceneRunnerFactory,
}: DagViewProps) {
  const { t } = useT("issues");
  const { t: tDag } = useT("dag");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const catalog = useIssueStatuses(wsId);
  const storeApi = useViewStoreApi();
  const baseline = useViewBaseline();
  const lineId = useViewStore((s) => s.dagLineId);
  const pinned = useViewStore((s) => s.dagOverviewPinned);
  const showCompleted = useViewStore((s) => s.dagShowCompleted);
  const showSatisfied = useViewStore((s) => s.dagShowSatisfiedDependencies);
  const focus = useViewStore((s) => s.dagFocus);
  const selectedNodeId = useViewStore((s) => s.dagSelectedNodeId);
  const canvasApi = useRef<DagSceneCanvasApi | null>(null);
  const registerCanvasApi = useCallback((api: DagSceneCanvasApi | null) => {
    canvasApi.current = api;
  }, []);
  useEffect(() => {
    void loadDagCanvas().catch(() => undefined);
  }, []);

  const supported = spec.scope.kind === "workspace" || spec.scope.kind === "project";
  const safeSpec = supported ? spec : UNSUPPORTED_SCOPE_SPEC;
  const isIndependent = lineId === DAG_INDEPENDENT_GROUP;
  const request = useMemo<DagModelRequest>(
    () =>
      lineId && !isIndependent
        ? { view: "line", lineId }
        : { view: "overview", showCompleted, showSatisfiedDependencies: showSatisfied },
    [lineId, isIndependent, showCompleted, showSatisfied],
  );
  const { models, ...query } = useDagModels(wsId, safeSpec, request, supported);
  const graph = query.data;
  const issuesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  );
  const projectNames = useMemo(
    () => new Map((graph?.projects ?? []).map((p) => [p.id, p.title])),
    [graph],
  );

  const canvasModel = useMemo<DagCanvasModel | null>(() => {
    if (!models) return null;
    if (!lineId)
      return models.overview ? { kind: "overview", overview: models.overview } : null;
    if (isIndependent) {
      const card = models.overview?.cards.find((c) => c.kind === "independent");
      if (!models.overview || !card) return null;
      const tasks: DagTask[] = [];
      for (const id of card.memberIds) {
        const node = issuesById.get(id);
        if (node)
          tasks.push({
            issue: toDagIssue(node),
            parentId: null,
            isFrame: false,
            role: node.role,
            cancelledBlocking: false,
          });
      }
      return { kind: "independent", tasks };
    }
    return models.line
      ? { kind: "line", line: dagLineWithSatisfiedFilter(models.line, showSatisfied) }
      : null;
  }, [models, lineId, isIndependent, issuesById, showSatisfied]);

  const plan = useMemo(() => {
    if (!canvasModel) return null;
    switch (canvasModel.kind) {
      case "overview":
        return dagOverviewLayoutInput(canvasModel.overview);
      case "line":
        return dagLineLayoutInput(canvasModel.line);
      case "independent":
        return dagIndependentLayoutInput(canvasModel.tasks);
    }
  }, [canvasModel]);

  // One mounted hook across both levels keeps the per-kind workers and the
  // 24-entry LRUs warm; the key carries the workspace + query identity.
  const sceneScope = `${wsId}:${hashKey([safeSpec])}`;
  const scene = useDagSceneLayout(sceneScope, plan, canvasModel, sceneRunnerFactory);

  // Navigation rules -------------------------------------------------------
  // A restored or followed line can disappear (deleted, filtered out, or no
  // longer a line): fall back to the overview.
  useEffect(() => {
    if (!lineId || !models) return;
    if (isIndependent) {
      if (models.overview && !models.overview.cards.some((c) => c.kind === "independent"))
        storeApi.getState().setDagLineId(null);
      return;
    }
    if (models.line === null) storeApi.getState().setDagLineId(null);
  }, [lineId, isIndependent, models, storeApi]);

  // A single visible line opens directly — until the user deliberately
  // returns to the overview (recorded in dagOverviewPinned).
  useEffect(() => {
    if (lineId) return;
    const target = dagAutoEnterLineId({
      pinned,
      autoEnterLineId: models?.overview?.autoEnterLineId ?? null,
    });
    if (target) storeApi.getState().setDagLineId(target);
  }, [lineId, pinned, models, storeApi]);

  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const locateOnOverview = useCallback((cardId: string) => {
    setFocusRequest((current) => ({ id: cardId, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const onEnterLine = useCallback(
    (nextLineId: string) => storeApi.getState().enterDagLine(nextLineId),
    [storeApi],
  );
  const onExitLine = useCallback(() => {
    const state = storeApi.getState();
    state.exitDagLine(state.dagLineId ? dagOverviewCardIdForLine(state.dagLineId) : null);
  }, [storeApi]);
  const onExternalJump = useCallback(
    (group: { id: string; kind: "line" | "issue" }) => {
      const jump = dagExternalJumpTarget(group);
      const state = storeApi.getState();
      if (jump.kind === "line") state.enterDagLine(jump.lineId);
      else {
        state.exitDagLine(jump.cardId);
        locateOnOverview(jump.cardId);
      }
    },
    [storeApi, locateOnOverview],
  );
  const onOpenIssue = useCallback(
    (issueId: string) => {
      // Persist the live viewport under the painted level so an in-flight pan
      // survives the round-trip to the issue detail.
      const viewport = canvasApi.current?.getViewport();
      const paintedPlan = scene.plan;
      if (viewport && paintedPlan)
        storeApi.getState().setDagViewportFor(
          dagLevelViewportKey(
            paintedPlan.input.kind === "overview"
              ? DAG_OVERVIEW_LEVEL
              : { kind: "line", lineId: paintedPlan.input.id },
          ),
          viewport,
        );
      navigation.push(paths.issueDetail(issueId));
    },
    [navigation, paths, storeApi, scene.plan],
  );

  // Pending long enough to offer a cancel (same five seconds as before).
  const [pendingLong, setPendingLong] = useState(false);
  useEffect(() => {
    if (!scene.pending) {
      setPendingLong(false);
      return;
    }
    const timer = setTimeout(() => setPendingLong(true), 5000);
    return () => clearTimeout(timer);
  }, [scene.pending]);

  const clearFilters = useCallback(() => {
    const state = storeApi.getState();
    if (baseline) state.resetFiltersTo(baseline.raw);
    else state.clearFilters();
  }, [baseline, storeApi]);

  // Toolbar data -----------------------------------------------------------
  const paintedModel = scene.snapshot ?? undefined;
  const paintedPlan = scene.plan;
  const paintedLevel = paintedPlan
    ? paintedPlan.input.kind === "overview"
      ? DAG_OVERVIEW_LEVEL
      : { kind: "line" as const, lineId: paintedPlan.input.id }
    : null;

  const stats = useMemo(() => {
    if (!paintedModel || !paintedPlan) return { matched: 0, context: 0, edges: 0 };
    if (paintedModel.kind === "overview") {
      let matched = 0,
        context = 0;
      for (const card of paintedModel.overview.cards) {
        matched += card.matchCount;
        context += card.contextCount;
      }
      const states = dagDependencyStates(paintedModel);
      let edges = 0;
      for (const edgeId of [
        ...paintedPlan.input.edges.map((e) => e.id),
        ...(showSatisfied ? paintedPlan.overlays.map((e) => e.id) : []),
      ]) {
        edges += dagSceneEdgeDisplay(paintedPlan, edgeId, states, showSatisfied)?.count ?? 0;
      }
      return { matched, context, edges };
    }
    if (paintedModel.kind === "line") {
      const members = paintedModel.line.input.members;
      return {
        matched: members.filter((m) => m.role === "match").length,
        context: members.filter((m) => m.role !== "match").length,
        edges:
          paintedModel.line.dependencies.filter((d) => !d.hiddenByDefault).length +
          paintedModel.line.upstream.reduce((n, g) => n + g.count, 0) +
          paintedModel.line.downstream.reduce((n, g) => n + g.count, 0),
      };
    }
    return {
      matched: paintedModel.tasks.filter((task) => task.role === "match").length,
      context: paintedModel.tasks.filter((task) => task.role !== "match").length,
      edges: 0,
    };
  }, [paintedModel, paintedPlan, showSatisfied]);

  const selection = useMemo(
    () => (paintedModel ? resolveDagSelection(paintedModel, selectedNodeId) : null),
    [paintedModel, selectedNodeId],
  );

  // How many chain tasks stay hidden behind the completed filter — only the
  // overview hides lines, so the hint belongs to that level.
  const focusHiddenCount = useMemo(() => {
    if (!focus || !graph || !paintedModel || paintedModel.kind !== "overview") return 0;
    const card = paintedModel.overview.cards.find((c) => c.id === focus.nodeId);
    if (!card) return 0;
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const from = focus.way === "upstream" ? edge.target : edge.source;
      const to = focus.way === "upstream" ? edge.source : edge.target;
      const list = adjacency.get(from) ?? [];
      list.push(to);
      adjacency.set(from, list);
    }
    const seen = new Set(card.memberIds);
    const stack = [...card.memberIds];
    let hidden = 0;
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (!paintedModel.overview.representatives.has(next)) hidden++;
        stack.push(next);
      }
    }
    return hidden;
  }, [focus, graph, paintedModel]);

  const lineHeader = useMemo(() => {
    if (!lineId) return null;
    if (isIndependent) return { identifier: null, title: tDag(($) => $.independent_group) };
    const root: DagIssue | undefined = models?.line?.input.members[0]?.issue;
    return root ? { identifier: root.identifier, title: root.title } : null;
  }, [lineId, isIndependent, models, tDag]);

  // Render -----------------------------------------------------------------
  if (query.isPending) {
    return (
      <div
        className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground"
        role="status"
      >
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
        <p className="text-body">
          {hasActiveFilters
            ? tDag(($) => $.empty_title)
            : tDag(($) => $.empty_title_unfiltered)}
        </p>
        <p className="text-caption">
          {hasActiveFilters
            ? tDag(($) => $.empty_hint)
            : tDag(($) => $.empty_hint_unfiltered)}
        </p>
        {hasActiveFilters && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={clearFilters}
          >
            {t(($) => $.filtered_empty.clear_button)}
          </Button>
        )}
      </div>
    );
  }

  const firstLayoutPending = !scene.geometry || !paintedPlan || !paintedModel;
  if (scene.error && firstLayoutPending) {
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
      >
        <p>{tDag(($) => $.layout_error)}</p>
        <Button variant="outline" size="sm" onClick={scene.retry}>
          {tDag(($) => $.error_retry)}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <DagToolbar
        level={dagLevelFromLineId(lineId)}
        lineHeader={lineHeader}
        selection={selection}
        stats={stats}
        hiddenCompleted={
          !lineId && models?.overview ? models.overview.hiddenCompleted : null
        }
        hasRestrictedContext={graph.hasRestrictedContext}
        contextOnly={graph.matchedCount === 0 && graph.contextCount > 0}
        pending={scene.pending}
        pendingLong={pendingLong}
        onCancelLayout={scene.cancel}
        isFallback={scene.geometry?.quality === "fallback"}
        onRetryLayout={scene.retry}
        focusHiddenCount={focusHiddenCount}
        onOpenIssue={onOpenIssue}
        onEnterLine={onEnterLine}
        onExitLine={onExitLine}
      />

      {scene.error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b px-3 py-2 text-caption text-warning"
        >
          <span>{tDag(($) => $.layout_error)}</span>
          <Button size="sm" variant="ghost" onClick={scene.retry}>
            {tDag(($) => $.error_retry)}
          </Button>
        </div>
      )}
      {query.isError && (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-caption text-warning"
          role="alert"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {tDag(($) => $.stale_banner, { time: graph.capturedAt })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
            {tDag(($) => $.error_retry)}
          </Button>
        </div>
      )}

      {firstLayoutPending ? (
        <div className="flex flex-1 min-h-0 flex-col gap-3 p-4" role="status">
          <span className="sr-only">{tDag(($) => $.layout_pending)}</span>
          <Skeleton className="h-24 w-72 rounded-lg" />
          <div className="flex gap-8">
            <Skeleton className="h-24 w-72 rounded-lg" />
            <Skeleton className="h-24 w-72 rounded-lg" />
          </div>
          <Skeleton className="h-24 w-72 rounded-lg" />
        </div>
      ) : (
        <Suspense
          fallback={
            <div
              className="flex flex-1 min-h-0 items-center justify-center text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-6 w-6 animate-spin text-faint-foreground" />
              <span className="sr-only">{tDag(($) => $.loading)}</span>
            </div>
          }
        >
          <DagSceneCanvas
            level={paintedLevel!}
            model={paintedModel!}
            geometry={scene.geometry!}
            plan={paintedPlan!}
            statusColorOf={catalog.colorOf}
            projectNames={projectNames}
            showSatisfied={showSatisfied}
            focusRequest={focusRequest}
            onEnterLine={onEnterLine}
            onOpenIssue={onOpenIssue}
            onExternalJump={onExternalJump}
            registerCanvasApi={registerCanvasApi}
          />
        </Suspense>
      )}
    </div>
  );
}
