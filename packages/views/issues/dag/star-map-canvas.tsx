"use client";

import { useEffect, useRef } from "react";
import {
  clampStarMapCamera,
  dagIssueFinished,
  fitStarMapCamera,
  nearestStarMapNode,
  starMapMorphAt,
  type StarMapEdge,
  type StarMapHierarchy,
  type StarMapNode,
  type StarMapPoint,
  type StarMapViewport,
} from "@multica/core/issues/dag";
import { useT } from "../../i18n";
import type { DagSceneCanvasProps } from "./dag-scene-canvas";
import { dagExternalNodeId } from "./dag-scene";
import { dagSceneContentBounds } from "./dag-viewport";
import { DAG_GROUP_HEADER_HEIGHT, DAG_STAGE_HEADER_HEIGHT } from "./dag-constants";
import type { StarMapFocusIntent, StarMapLayers, StarMapLayoutMode, StarMapScale } from "./star-map-controls";
import { rgba, StarMapSpriteCache, type StarMapRGB } from "./star-map-sprites";

const SANS = '"Inter",-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",system-ui,sans-serif';
const NUM = '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const DURATION = 440;
const TAU = Math.PI * 2;
const WHITE: StarMapRGB = [226, 232, 240];
const CYAN: StarMapRGB = [125, 211, 252];
const GREEN: StarMapRGB = [110, 231, 183];
const VIOLET: StarMapRGB = [196, 181, 253];
const ORANGE: StarMapRGB = [251, 146, 60];
const SMOKE: StarMapRGB = [100, 116, 139];
const PROJECT_COLORS: readonly StarMapRGB[] = [
  [226, 232, 240], [165, 243, 252], [221, 214, 254], [254, 240, 138],
  [187, 247, 208], [254, 202, 202], [191, 219, 254], [245, 208, 254],
];
const LABEL_DIRECTIONS = ["bottom", "top", "right", "left", "bottom-right", "bottom-left", "top-right", "top-left"] as const;

type PaintedTarget = Pick<DagSceneCanvasProps, "geometry" | "plan"> & {
  model: Extract<DagSceneCanvasProps["model"], { kind: "line" | "focus" }>;
};
type Phase = "orbital" | "entering" | "linear" | "exiting";

interface CardTarget {
  x: number;
  y: number;
  w: number;
  h: number;
}

type MutablePoint = { x: number; y: number };
type MutableCamera = { -readonly [K in keyof StarMapViewport]: StarMapViewport[K] };

interface RuntimeNode {
  data: StarMapNode;
  orbX: number;
  orbY: number;
  x: number;
  y: number;
  r: number;
  w: number;
  h: number;
  veil: number;
  emergence: number;
  angle: number;
  inLinearScene: boolean;
  activeSubtree: boolean;
  target?: CardTarget;
}

interface Runtime {
  nodes: RuntimeNode[];
  nearestNodes: StarMapNode[];
  drawNodes: RuntimeNode[];
  byId: Map<string, RuntimeNode>;
  positions: Map<string, MutablePoint>;
  camera: MutableCamera;
  cameraGoal: MutableCamera | null;
  homeIssueId: string | null;
  width: number;
  height: number;
  dpr: number;
  orbitalTime: number;
  timeScale: number;
  morph: number;
  morphStartedAt: number;
  morphCameraStart: MutableCamera | null;
  target: PaintedTarget | null;
  targetCamera: MutableCamera | null;
  targetCards: Map<string, CardTarget>;
  routeByRaw: Map<string, { route: readonly StarMapPoint[]; kind?: "wakeup" | "mention" }>;
  cursor: MutablePoint & { inside: boolean };
  hoverId: string | null;
  hoverEdgeId: string | null;
  selectedId: string | null;
  previewId: string | null;
  litNodes: Set<string>;
  litEdges: Set<string>;
  panning: { x: number; y: number; cameraX: number; cameraY: number } | null;
  down: StarMapPoint | null;
  linkSource: string | null;
  completionSent: boolean;
  lastFrame: number;
}

export interface StarMapCanvasProps {
  hierarchy: StarMapHierarchy;
  target: PaintedTarget | null;
  phase: Phase;
  layers: StarMapLayers;
  layout: StarMapLayoutMode;
  intent: StarMapFocusIntent;
  orbiting: boolean;
  linking: boolean;
  light: boolean;
  peekOpen: boolean;
  reducedMotion: boolean;
  initialCamera: StarMapViewport | null;
  locateRequest: { id: string; nonce: number } | null;
  scaleCommand: { kind: StarMapScale; nonce: number } | null;
  onRequestScene: (issueId: string, intent: StarMapFocusIntent) => void;
  onMorphComplete: (camera: StarMapViewport) => void;
  onExitToOrbit: () => void;
  onOpenIssue: (issueId: string) => void;
  onAddBlocker: (source: string, target: string) => void;
  onRemoveBlocker: (source: string, target: string) => void;
}

function smoothstep(a: number, b: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function closed(node: StarMapNode) {
  return dagIssueFinished(node.issue);
}

function running(node: StarMapNode) {
  return (node.issue.runSummary?.running ?? 0) > 0;
}

function statusRGB(node: StarMapNode): StarMapRGB {
  if (running(node)) return GREEN;
  if (node.issue.status === "blocked") return ORANGE;
  if (node.issue.status === "in_review") return VIOLET;
  if (closed(node)) return SMOKE;
  if (node.issue.statusCategory === "started") return CYAN;
  return SMOKE;
}

function projectRGB(node: StarMapNode): StarMapRGB {
  if (!node.projectId) return WHITE;
  let hash = 0;
  for (let i = 0; i < node.projectId.length; i++) hash = (hash * 31 + node.projectId.charCodeAt(i)) | 0;
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length]!;
}

function numericIdentifier(identifier: string) {
  return identifier.match(/\d+/)?.[0] ?? identifier;
}

function shortTitle(title: string) {
  return title.length > 30 ? `${title.slice(0, 29)}…` : title;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function insets(peekOpen: boolean) {
  return { left: 28, right: peekOpen ? 548 : 28, top: 64, bottom: 64 };
}

function makeRuntime(hierarchy: StarMapHierarchy): Runtime {
  const nodes = hierarchy.nodes.map((data) => ({
    data,
    orbX: data.anchor.x,
    orbY: data.anchor.y,
    x: data.anchor.x,
    y: data.anchor.y,
    r: data.coreRadius,
    w: data.coreRadius * 2,
    h: data.coreRadius * 2,
    veil: data.childrenIds.length ? 1 : 0,
    emergence: data.depth === 0 ? 1 : 0,
    angle: data.baseAngle,
    inLinearScene: false,
    activeSubtree: !closed(data),
  }));
  const byId = new Map(nodes.map((node) => [node.data.id, node]));
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.activeSubtree) continue;
    node.activeSubtree = node.data.childrenIds.some((id) => byId.get(id)?.activeSubtree);
  }
  return {
    nodes,
    nearestNodes: [],
    drawNodes: [...nodes].sort((a, b) => b.data.depth - a.data.depth),
    byId,
    positions: new Map(nodes.map((node) => [node.data.id, { x: node.orbX, y: node.orbY }])),
    camera: { x: 0, y: 0, zoom: 0.3 },
    cameraGoal: null,
    homeIssueId: null,
    width: 1,
    height: 1,
    dpr: 1,
    orbitalTime: 0,
    timeScale: 1,
    morph: 0,
    morphStartedAt: 0,
    morphCameraStart: null,
    target: null,
    targetCamera: null,
    targetCards: new Map(),
    routeByRaw: new Map(),
    cursor: { x: 0, y: 0, inside: false },
    hoverId: null,
    hoverEdgeId: null,
    selectedId: null,
    previewId: null,
    litNodes: new Set(),
    litEdges: new Set(),
    panning: null,
    down: null,
    linkSource: null,
    completionSent: false,
    lastFrame: 0,
  };
}

export function starMapMacroBounds(hierarchy: StarMapHierarchy) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const root of hierarchy.roots) {
    const pad = root.domainRadius + 60;
    left = Math.min(left, root.anchor.x - pad);
    right = Math.max(right, root.anchor.x + pad);
    top = Math.min(top, root.anchor.y - pad);
    bottom = Math.max(bottom, root.anchor.y + pad);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : { left: -200, top: -150, right: 200, bottom: 150 };
}

function targetBounds(target: PaintedTarget) {
  const rect = dagSceneContentBounds(target.geometry);
  return rect
    ? { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
    : { left: 0, top: 0, right: 1, bottom: 1 };
}

function targetCards(target: PaintedTarget) {
  const cards = new Map<string, CardTarget>();
  const externalIds = new Map<string, string>();
  if (target.model.kind === "line") {
    for (const side of ["upstream", "downstream"] as const)
      for (const group of target.model.line[side])
        externalIds.set(dagExternalNodeId(side, group.id), group.id);
  }
  for (const [id, box] of Object.entries(target.geometry.nodes)) {
    const issueId = externalIds.get(id) ?? id;
    cards.set(issueId, { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height });
  }
  return cards;
}

function createBackground(width: number, height: number, light: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.44, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.78);
  gradient.addColorStop(0, light ? "#f8fafc" : "#0d111a");
  gradient.addColorStop(1, light ? "#edf1f7" : "#07090e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  let seed = 1536;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  if (!light) {
    for (let i = 0; i < 110; i++) {
      ctx.fillStyle = `rgba(226,232,240,${0.025 + random() * 0.11})`;
      const size = random() > 0.93 ? 1.2 : 0.65;
      ctx.fillRect(random() * width, random() * height, size, size);
    }
  }
  return canvas;
}

function arcControl(a: StarMapPoint, b: StarMapPoint, edge: StarMapEdge) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  let hash = 0;
  for (let i = 0; i < edge.id.length; i++) hash = (hash * 33 + edge.id.charCodeAt(i)) | 0;
  const bend = Math.min(90, length * 0.12) * (hash % 2 ? 1 : -1);
  return { x: mx - (dy / length) * bend, y: my + (dx / length) * bend };
}

function quadAt(a: StarMapPoint, c: StarMapPoint, b: StarMapPoint, t: number): StarMapPoint {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function routeAt(route: readonly StarMapPoint[], t: number): StarMapPoint {
  if (route.length < 2) return route[0] ?? { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < route.length; i++) total += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
  let remaining = total * t;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === route.length - 1) {
      const f = length ? Math.min(1, remaining / length) : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= length;
  }
  return route[route.length - 1]!;
}

function nodeVisible(node: RuntimeNode, layers: StarMapLayers, selectedId: string | null) {
  return node.inLinearScene || layers.completed || !closed(node.data) || node.activeSubtree || node.data.id === selectedId;
}

export function starMapNodeSize(radius: number, target: CardTarget | undefined, morph: number) {
  const m = target && morph > 0.004 ? morph : 0;
  return {
    w: radius * 2 * (1 - m) + (target?.w ?? radius * 2) * m,
    h: radius * 2 * (1 - m) + (target?.h ?? radius * 2) * m,
  };
}

export function starMapNodeRect(node: Pick<RuntimeNode, "x" | "y" | "w" | "h">) {
  return { x: node.x - node.w / 2, y: node.y - node.h / 2, w: node.w, h: node.h };
}

/** The orb occupies 68% of its sprite's width and height. Scale the full
 * texture so that visible core, not the transparent border, matches node.w/h. */
export const STAR_MAP_ORB_VISIBLE_FRACTION = 0.68;
export function starMapSpriteRect(node: Pick<RuntimeNode, "x" | "y" | "w" | "h">) {
  const w = node.w / STAR_MAP_ORB_VISIBLE_FRACTION;
  const h = node.h / STAR_MAP_ORB_VISIBLE_FRACTION;
  return { x: node.x - w / 2, y: node.y - h / 2, w, h };
}

export function starMapTimeScaleTarget(orbiting: boolean, reducedMotion: boolean, slowed: boolean, morph: number) {
  if (!orbiting || reducedMotion) return 0;
  return (slowed ? 0.08 : 1) * (1 - morph);
}

function edgeAppearance(edge: StarMapEdge, runtime: Runtime, current: StarMapCanvasProps) {
  if (!current.layers[edge.kind]) return null;
  const source = runtime.byId.get(edge.source), target = runtime.byId.get(edge.target);
  if (!source || !target || !nodeVisible(source, current.layers, runtime.selectedId) || !nodeVisible(target, current.layers, runtime.selectedId)) return null;
  const route = runtime.routeByRaw.get(edge.id);
  const selected = runtime.selectedId && runtime.litEdges.has(edge.id);
  const dim = runtime.selectedId && !selected ? 0.16 : 1;
  const alpha = (route ? 1 : 1 - runtime.morph) * dim * Math.min(source.emergence + 0.15, target.emergence + 0.15);
  return alpha < 0.015 ? null : { source, target, route, m: route ? runtime.morph : 0, selected, alpha };
}

export function StarMapCanvas(props: StarMapCanvasProps) {
  const { t } = useT("dag");
  const tRef = useRef(t);
  tRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const runtimeRef = useRef<Runtime | null>(null);
  if (!runtimeRef.current) runtimeRef.current = makeRuntime(props.hierarchy);
  const layoutRef = useRef<StarMapLayoutMode | null>(null);
  const spritesRef = useRef<StarMapSpriteCache | null>(null);
  if (!spritesRef.current) spritesRef.current = new StarMapSpriteCache(props.light);
  const backgroundRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const drawRef = useRef<(runtime: Runtime, current: StarMapCanvasProps) => void>(() => {});
  const peekWasOpen = useRef(props.peekOpen);

  const fitMacro = (instant = false) => {
    const runtime = runtimeRef.current!;
    runtime.homeIssueId = null;
    const next = fitStarMapCamera(starMapMacroBounds(propsRef.current.hierarchy), { width: runtime.width, height: runtime.height }, {
      insets: insets(propsRef.current.peekOpen), minZoom: 0.12, maxZoom: 0.45, fill: 0.92,
    });
    if (instant || propsRef.current.reducedMotion) {
      runtime.camera = next;
      runtime.cameraGoal = null;
    } else runtime.cameraGoal = next;
  };

  const focusMeso = (issueId?: string) => {
    const runtime = runtimeRef.current!;
    const node = issueId ? runtime.byId.get(issueId) : runtime.byId.get(runtime.previewId ?? runtime.selectedId ?? "") ?? runtime.nodes.find((candidate) => candidate.data.depth === 0);
    if (!node) return fitMacro();
    const root = runtime.byId.get(node.data.rootId) ?? node;
    runtime.homeIssueId = root.data.id;
    const zoom = 0.72;
    const padding = insets(propsRef.current.peekOpen);
    const usableWidth = Math.max(240, runtime.width - padding.left - padding.right);
    const usableHeight = Math.max(180, runtime.height - padding.top - padding.bottom);
    runtime.cameraGoal = {
      zoom,
      x: padding.left + usableWidth / 2 - root.orbX * zoom,
      y: padding.top + usableHeight / 2 - root.orbY * zoom,
    };
  };

  const focusMesoRef = useRef(focusMeso);
  focusMesoRef.current = focusMeso;

  const selectNode = (id: string | null) => {
    const runtime = runtimeRef.current!;
    runtime.selectedId = id;
    runtime.litNodes.clear();
    runtime.litEdges.clear();
    if (!id) return;
    const seed = runtime.byId.get(id);
    if (!seed) return;
    runtime.litNodes.add(id);
    for (const childId of seed.data.childrenIds) runtime.litNodes.add(childId);
    if (seed.data.parentId) runtime.litNodes.add(seed.data.parentId);
    const chain = propsRef.current.intent === "chain";
    const queue = chain ? [id] : [];
    const visited = new Set([id]);
    const visit = (edge: StarMapEdge) => {
      runtime.litEdges.add(edge.id);
      runtime.litNodes.add(edge.source);
      runtime.litNodes.add(edge.target);
      if (!chain) return;
      for (const endpoint of [edge.source, edge.target]) {
        if (!visited.has(endpoint)) {
          visited.add(endpoint);
          queue.push(endpoint);
        }
      }
    };
    for (const edge of propsRef.current.hierarchy.edges) {
      if (!propsRef.current.layers[edge.kind]) continue;
      if (edge.source === id || edge.target === id) visit(edge);
    }
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of propsRef.current.hierarchy.edges) {
        if (!propsRef.current.layers[edge.kind] || edge.kind === "mention") continue;
        if (edge.source === current || edge.target === current) visit(edge);
      }
    }
    if (liveRef.current) liveRef.current.textContent = `${seed.data.issue.identifier} ${seed.data.issue.title}`;
  };

  useEffect(() => {
    const previous = runtimeRef.current;
    const next = makeRuntime(props.hierarchy);
    const previousLayout = layoutRef.current;
    layoutRef.current = props.layout;
    if (previous) {
      next.width = previous.width;
      next.height = previous.height;
      next.dpr = previous.dpr;
      next.camera = previous.camera;
      next.cameraGoal = previous.cameraGoal;
      next.homeIssueId = previous.homeIssueId && next.byId.has(previous.homeIssueId) ? previous.homeIssueId : null;
      next.selectedId = previous.selectedId && next.byId.has(previous.selectedId) ? previous.selectedId : null;
      next.hoverId = previous.hoverId && next.byId.has(previous.hoverId) ? previous.hoverId : null;
      next.hoverEdgeId = previous.hoverEdgeId && props.hierarchy.edges.some((edge) => edge.id === previous.hoverEdgeId) ? previous.hoverEdgeId : null;
      next.previewId = previous.previewId && next.byId.has(previous.previewId) ? previous.previewId : null;
      next.linkSource = previous.linkSource && next.byId.has(previous.linkSource) ? previous.linkSource : null;
    }
    runtimeRef.current = next;
    if (next.selectedId) selectNode(next.selectedId);
    if (previousLayout === null || previousLayout !== props.layout) fitMacro(true);
  }, [props.hierarchy, props.layout]);

  useEffect(() => {
    spritesRef.current = new StarMapSpriteCache(props.light);
    backgroundRef.current = null;
  }, [props.light]);

  useEffect(() => {
    const runtime = runtimeRef.current!;
    runtime.target = props.target;
    runtime.targetCards = props.target ? targetCards(props.target) : new Map();
    runtime.routeByRaw.clear();
    if (props.target) {
      for (const sceneEdge of props.target.plan.input.edges) {
        const route = props.target.geometry.routes[sceneEdge.id];
        if (!route) continue;
        const rawIds = props.target.plan.dependencyIds[sceneEdge.id] ?? [sceneEdge.id];
        for (const rawId of rawIds) runtime.routeByRaw.set(rawId, { route, kind: sceneEdge.kind });
      }
      runtime.targetCamera = fitStarMapCamera(targetBounds(props.target), { width: runtime.width, height: runtime.height }, {
        insets: insets(props.peekOpen), minZoom: 0.05, maxZoom: 1.56, fill: 0.94,
      });
    } else runtime.targetCamera = null;
    runtime.completionSent = false;
    const now = performance.now();
    if (props.phase === "entering" && props.target) {
      runtime.morphStartedAt = now - runtime.morph * (props.reducedMotion ? 1 : DURATION);
    } else if (props.phase === "exiting") {
      if (props.initialCamera) {
        runtime.camera = { ...props.initialCamera };
        runtime.morph = 1;
      }
      runtime.morphStartedAt = now - (1 - runtime.morph) * (props.reducedMotion ? 1 : DURATION);
      const sceneSeed = runtime.selectedId ?? props.target?.plan.input.id;
      const focus = runtime.byId.get(sceneSeed ?? "") ?? runtime.nodes.find((node) => node.data.depth === 0);
      if (focus) {
        const root = runtime.byId.get(focus.data.rootId) ?? focus;
        runtime.homeIssueId = root.data.id;
        const zoom = 0.72;
        const padding = insets(props.peekOpen);
        runtime.targetCamera = {
          zoom,
          x: padding.left + Math.max(240, runtime.width - padding.left - padding.right) / 2 - root.orbX * zoom,
          y: padding.top + Math.max(180, runtime.height - padding.top - padding.bottom) / 2 - root.orbY * zoom,
        };
      }
    } else if (props.phase === "orbital") {
      runtime.morph = 0;
      runtime.morphStartedAt = now;
      runtime.target = null;
      runtime.targetCamera = null;
      runtime.cameraGoal = null;
    }
    runtime.morphCameraStart = { ...runtime.camera };
  }, [props.target, props.phase, props.initialCamera, props.peekOpen, props.reducedMotion]);

  useEffect(() => {
    const changed = peekWasOpen.current !== props.peekOpen;
    peekWasOpen.current = props.peekOpen;
    if (changed && props.phase === "orbital") fitMacro();
  }, [props.peekOpen, props.phase]);

  useEffect(() => {
    const command = props.scaleCommand;
    if (!command) return;
    if (command.kind === "macro") fitMacro();
    else if (command.kind === "meso") focusMesoRef.current();
    else {
      const runtime = runtimeRef.current!;
      const target = runtime.byId.get(runtime.selectedId ?? runtime.previewId ?? "") ?? runtime.nodes.find((node) => node.data.depth === 0);
      if (target) propsRef.current.onRequestScene(target.data.id, propsRef.current.intent);
    }
  }, [props.scaleCommand]);

  useEffect(() => {
    const request = props.locateRequest;
    if (!request || props.phase !== "orbital") return;
    const runtime = runtimeRef.current!;
    const node = runtime.byId.get(request.id);
    if (!node) return;
    selectNode(request.id);
    focusMesoRef.current(request.id);
  }, [props.locateRequest, props.phase]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const runtime = runtimeRef.current!;
      const rect = canvas.getBoundingClientRect();
      runtime.width = Math.max(1, rect.width);
      runtime.height = Math.max(1, rect.height);
      runtime.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(runtime.width * runtime.dpr);
      canvas.height = Math.round(runtime.height * runtime.dpr);
      backgroundRef.current = null;
      const current = propsRef.current;
      if (current.phase === "orbital") {
        if (runtime.homeIssueId) focusMesoRef.current(runtime.homeIssueId);
        else fitMacro(true);
      } else if (current.phase === "entering" && runtime.target) {
        runtime.targetCamera = fitStarMapCamera(targetBounds(runtime.target), { width: runtime.width, height: runtime.height }, {
          insets: insets(current.peekOpen), minZoom: 0.05, maxZoom: 1.56, fill: 0.94,
        });
        runtime.morphCameraStart = { ...runtime.camera };
      } else if (current.phase === "exiting" && runtime.homeIssueId) {
        const root = runtime.byId.get(runtime.homeIssueId);
        if (root) {
          const zoom = 0.72;
          const padding = insets(current.peekOpen);
          runtime.targetCamera = {
            zoom,
            x: padding.left + Math.max(240, runtime.width - padding.left - padding.right) / 2 - root.orbX * zoom,
            y: padding.top + Math.max(180, runtime.height - padding.top - padding.bottom) / 2 - root.orbY * zoom,
          };
          runtime.morphCameraStart = { ...runtime.camera };
        }
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const runtime = runtimeRef.current!;
      const rect = canvas.getBoundingClientRect();
      runtime.cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
      const current = propsRef.current;
      if (current.phase === "entering" || current.phase === "exiting") {
        if (event.deltaY > 0) current.onExitToOrbit();
        return;
      }
      const factor = Math.exp(-event.deltaY * 0.00145);
      const nextZoom = Math.max(0.12, Math.min(2.2, runtime.camera.zoom * factor));
      if (event.deltaY < 0 && nextZoom >= 0.9) {
        const nearest = nearestStarMapNode(runtime.nearestNodes, runtime.positions, runtime.cursor, runtime.camera.zoom);
        const node = nearest?.node ?? runtime.nearestNodes.find((candidate) => candidate.depth === 0);
        if (node) {
          selectNode(node.id);
          current.onRequestScene(node.id, current.intent);
        }
        return;
      }
      runtime.cameraGoal = null;
      const worldX = (runtime.cursor.x - runtime.camera.x) / runtime.camera.zoom;
      const worldY = (runtime.cursor.y - runtime.camera.y) / runtime.camera.zoom;
      runtime.camera = { x: runtime.cursor.x - worldX * nextZoom, y: runtime.cursor.y - worldY * nextZoom, zoom: nextZoom };
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      const runtime = runtimeRef.current!;
      const current = propsRef.current;
      const dt = runtime.lastFrame ? Math.min(0.05, (now - runtime.lastFrame) / 1000) : 1 / 60;
      runtime.lastFrame = now;
      const entering = current.phase === "entering" && runtime.target && runtime.targetCamera;
      const exiting = current.phase === "exiting" && runtime.target;
      if (entering || exiting) {
        const sample = starMapMorphAt(runtime.morphStartedAt, now, { duration: DURATION, reducedMotion: current.reducedMotion });
        runtime.morph = entering ? sample.eased : 1 - sample.eased;
        const destination = runtime.targetCamera!;
        const ease = sample.eased;
        if (!runtime.panning) {
          if (!runtime.morphCameraStart) runtime.morphCameraStart = { ...runtime.camera };
          const start = runtime.morphCameraStart;
          runtime.camera = {
            x: start.x + (destination.x - start.x) * ease,
            y: start.y + (destination.y - start.y) * ease,
            zoom: start.zoom + (destination.zoom - start.zoom) * ease,
          };
        }
        if (sample.done && !runtime.completionSent) {
          runtime.completionSent = true;
          current.onMorphComplete({ ...runtime.camera });
        }
      } else {
        runtime.morphCameraStart = null;
        if (runtime.cameraGoal) {
          const amount = current.reducedMotion ? 1 : Math.min(1, dt * 10);
          runtime.camera.x += (runtime.cameraGoal.x - runtime.camera.x) * amount;
          runtime.camera.y += (runtime.cameraGoal.y - runtime.camera.y) * amount;
          runtime.camera.zoom += (runtime.cameraGoal.zoom - runtime.camera.zoom) * amount;
          if (Math.abs(runtime.cameraGoal.x - runtime.camera.x) + Math.abs(runtime.cameraGoal.y - runtime.camera.y) < 0.05 && Math.abs(runtime.cameraGoal.zoom - runtime.camera.zoom) < 0.0001) {
            runtime.camera = runtime.cameraGoal;
            runtime.cameraGoal = null;
          }
        }
      }
      const easeM = runtime.morph;
      const desiredTimeScale = starMapTimeScaleTarget(current.orbiting, current.reducedMotion, Boolean(runtime.hoverId || runtime.linkSource), easeM);
      if (desiredTimeScale === 0) runtime.timeScale = 0;
      else runtime.timeScale += (desiredTimeScale - runtime.timeScale) * Math.min(1, dt * 7);
      runtime.orbitalTime += dt * runtime.timeScale;

      const update = (node: RuntimeNode, parent?: RuntimeNode) => {
        const data = node.data;
        if (!parent) {
          node.orbX = data.anchor.x;
          node.orbY = data.anchor.y;
        } else {
          node.angle = data.baseAngle + runtime.orbitalTime * data.angularVelocity;
          node.orbX = parent.orbX + Math.cos(node.angle) * data.orbitRadius;
          node.orbY = parent.orbY + Math.sin(node.angle) * data.orbitRadius;
        }
        const from = data.depth === 0 ? 0.46 : 0.82;
        const to = data.depth === 0 ? 0.8 : 1.06;
        const veilTarget = data.childrenIds.length ? (1 - smoothstep(from, to, runtime.camera.zoom)) * (1 - easeM) : 0;
        node.veil += (veilTarget - node.veil) * Math.min(1, dt * 10);
        node.emergence = parent ? parent.emergence * Math.pow(Math.max(0, 1 - parent.veil), 1.4) : 1;
        const dense = current.hierarchy.nodes.length > 180;
        const baseMinPx = data.depth === 0
          ? (data.childrenIds.length ? dense ? 12 : 20.5 : dense ? 9 : 14.5)
          : data.depth === 1 ? dense ? 10.5 : 14.8 : dense ? 9 : 13.8;
        // Fit the complete dense envelope without forcing 18px cores onto a
        // sub-0.45x view. Tiny far cores hide their digits; labels declutter.
        const minPx = dense ? baseMinPx * Math.min(1, runtime.camera.zoom / 0.45) : baseMinPx;
        const radius = Math.max(data.coreRadius, minPx / runtime.camera.zoom);
        node.x = parent ? node.orbX * (1 - parent.veil) + parent.x * parent.veil : node.orbX;
        node.y = parent ? node.orbY * (1 - parent.veil) + parent.y * parent.veil : node.orbY;
        node.r = parent ? radius * (1 - parent.veil) + parent.r * parent.veil : radius;
        if (nodeVisible(node, current.layers, runtime.selectedId) && node.emergence >= 0.22) runtime.nearestNodes.push(data);
        const position = runtime.positions.get(data.id)!;
        position.x = node.x * runtime.camera.zoom + runtime.camera.x;
        position.y = node.y * runtime.camera.zoom + runtime.camera.y;
        const card = runtime.targetCards.get(data.id);
        node.target = card;
        node.inLinearScene = Boolean(card && easeM > 0.004);
        if (node.inLinearScene) {
          node.x = node.x * (1 - easeM) + card!.x * easeM;
          node.y = node.y * (1 - easeM) + card!.y * easeM;
        }
        const size = starMapNodeSize(node.r, card, easeM);
        node.w = size.w;
        node.h = size.h;
        for (const childId of data.childrenIds) {
          const child = runtime.byId.get(childId);
          if (child) update(child, node);
        }
      };
      runtime.nearestNodes.length = 0;
      for (const node of runtime.nodes) if (node.data.depth === 0) update(node);

      if (current.phase === "orbital" && runtime.cursor.inside) {
        const nearest = nearestStarMapNode(runtime.nearestNodes, runtime.positions, runtime.cursor, runtime.camera.zoom);
        runtime.previewId = nearest?.node.id ?? null;
      } else runtime.previewId = null;

      drawRef.current(runtime, current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const draw = (runtime: Runtime, current: StarMapCanvasProps) => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const { width, height, dpr, camera } = runtime;
    const backgroundKey = `${width}:${height}:${current.light}`;
    if (backgroundRef.current?.key !== backgroundKey)
      backgroundRef.current = { key: backgroundKey, canvas: createBackground(width, height, current.light) };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backgroundRef.current.canvas, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);
    const orbitalAlpha = Math.pow(Math.max(0, 1 - runtime.morph), 1.4);
    if (orbitalAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = orbitalAlpha;
      drawGuides(ctx, runtime, current);
      ctx.restore();
    }
    if (runtime.target && runtime.morph > 0.02) drawFrames(ctx, runtime, current);
    drawEdges(ctx, runtime, current);
    for (const node of runtime.drawNodes) drawNode(ctx, node, runtime, current);
    ctx.restore();
    drawTypography(ctx, runtime, current);
    if (runtime.morph > 0.45 && runtime.target) drawCardContents(ctx, runtime, current);
    drawPreview(ctx, runtime, current);
    drawTooltip(ctx, runtime, current);
  };
  drawRef.current = draw;

  const drawGuides = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    ctx.lineWidth = 0.7 / runtime.camera.zoom;
    ctx.strokeStyle = current.light ? "rgba(15,23,42,.075)" : "rgba(226,232,240,.085)";
    for (const guide of current.hierarchy.sectorGuides) {
      ctx.beginPath();
      if (guide.kind === "cluster") ctx.arc(guide.cx, guide.cy, guide.radius, -Math.PI / 2 + 0.24, Math.PI * 1.5 - 0.24);
      else ctx.arc(0, 0, guide.outerR, guide.start, guide.end);
      ctx.stroke();
    }
    if (!current.layers.stage) return;
    for (const node of runtime.nodes) {
      if (!node.data.childrenIds.length || !nodeVisible(node, current.layers, runtime.selectedId)) continue;
      // Far LOD keeps only the root heliosphere. Hundreds of hidden moon
      // tracks are both visual noise and a large software-raster cost.
      if (node.data.depth > 0 && node.veil >= 0.35) continue;
      ctx.beginPath();
      ctx.arc(node.orbX, node.orbY, node.data.domainRadius, 0, TAU);
      ctx.stroke();
      if (node.veil >= 0.35) continue;
      for (const childId of node.data.childrenIds) {
        const child = runtime.byId.get(childId)!;
        ctx.beginPath();
        ctx.arc(node.orbX, node.orbY, child.data.orbitRadius, 0, TAU);
        ctx.stroke();
      }
    }
  };

  const drawFrames = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    const target = runtime.target!;
    const m = runtime.morph;
    for (const input of target.plan.input.frames) {
      const box = target.geometry.frames[input.id];
      if (!box) continue;
      const source = runtime.byId.get(input.modelId);
      const startRadius = source?.data.domainRadius ?? 80;
      const startX = source ? source.orbX - startRadius : box.x;
      const startY = source ? source.orbY - startRadius : box.y;
      const x = startX * (1 - m) + box.x * m;
      const y = startY * (1 - m) + box.y * m;
      const w = startRadius * 2 * (1 - m) + box.width * m;
      const h = startRadius * 2 * (1 - m) + box.height * m;
      ctx.globalAlpha = smoothstep(0.03, 0.42, m);
      roundRect(ctx, x, y, w, h, startRadius * (1 - m) + 9 * m);
      ctx.fillStyle = current.light ? "rgba(255,255,255,.62)" : "rgba(13,17,26,.76)";
      ctx.fill();
      ctx.strokeStyle = current.light ? "rgba(15,23,42,.12)" : "rgba(226,232,240,.14)";
      ctx.lineWidth = 1 / runtime.camera.zoom;
      ctx.stroke();
      if (m > 0.36) {
        ctx.globalAlpha = smoothstep(0.36, 0.8, m);
        ctx.fillStyle = current.light ? "rgba(241,245,249,.85)" : "rgba(255,255,255,.03)";
        ctx.fillRect(box.x, box.y, box.width, DAG_GROUP_HEADER_HEIGHT);
        if (box.stageMode === "columns") {
          for (let i = 0; i < box.bands.length; i++) {
            const band = box.bands[i]!;
            if (i % 2) {
              ctx.fillStyle = current.light ? "rgba(15,23,42,.022)" : "rgba(255,255,255,.018)";
              ctx.fillRect(band.start, box.y + DAG_GROUP_HEADER_HEIGHT, band.end - band.start, box.height - DAG_GROUP_HEADER_HEIGHT);
            }
            ctx.strokeStyle = current.light ? "rgba(15,23,42,.075)" : "rgba(255,255,255,.065)";
            ctx.beginPath();
            ctx.moveTo(band.start, box.y + DAG_GROUP_HEADER_HEIGHT);
            ctx.lineTo(band.start, box.y + box.height);
            ctx.stroke();
          }
          ctx.fillStyle = current.light ? "rgba(15,23,42,.035)" : "rgba(255,255,255,.025)";
          ctx.fillRect(box.x, box.y + DAG_GROUP_HEADER_HEIGHT, box.width, DAG_STAGE_HEADER_HEIGHT);
        }
      }
    }
    ctx.globalAlpha = 1;
  };

  const drawEdges = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    for (const edge of current.hierarchy.edges) {
      const appearance = edgeAppearance(edge, runtime, current);
      if (!appearance) continue;
      const { source, target, route, m, selected, alpha } = appearance;
      const a = { x: source.x, y: source.y }, b = { x: target.x, y: target.y };
      const control = arcControl(a, b, edge);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = edge.kind === "wakeup" ? rgba(VIOLET, current.light ? 0.58 : 0.68) : edge.kind === "mention" ? rgba(WHITE, 0.28) : selected ? rgba(CYAN, 0.86) : rgba(WHITE, current.light ? 0.32 : 0.25);
      ctx.lineWidth = (selected ? 1.4 : edge.kind === "mention" ? 0.55 : 0.85) / runtime.camera.zoom;
      if (edge.kind === "wakeup") ctx.setLineDash([4 / runtime.camera.zoom, 4 / runtime.camera.zoom]);
      else if (edge.kind === "mention") ctx.setLineDash([1 / runtime.camera.zoom, 5 / runtime.camera.zoom]);
      ctx.beginPath();
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const curved = quadAt(a, control, b, t);
        const straight = route ? routeAt(route.route, t) : curved;
        const x = curved.x * (1 - m) + straight.x * m;
        const y = curved.y * (1 - m) + straight.y * m;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (edge.kind === "manual" && !current.reducedMotion && runtime.morph < 0.9) {
        const t = (runtime.orbitalTime * 0.28 + edge.id.length * 0.07) % 1;
        const point = quadAt(a, control, b, t);
        ctx.fillStyle = rgba(CYAN, 0.85);
        ctx.beginPath();
        ctx.arc(point.x, point.y, 1.6 / runtime.camera.zoom, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    if (runtime.linkSource) {
      const source = runtime.byId.get(runtime.linkSource);
      if (source) {
        ctx.save();
        ctx.strokeStyle = rgba(CYAN, 0.85);
        ctx.lineWidth = 1.4 / runtime.camera.zoom;
        ctx.setLineDash([5 / runtime.camera.zoom, 4 / runtime.camera.zoom]);
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo((runtime.cursor.x - runtime.camera.x) / runtime.camera.zoom, (runtime.cursor.y - runtime.camera.y) / runtime.camera.zoom);
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  const drawNode = (ctx: CanvasRenderingContext2D, node: RuntimeNode, runtime: Runtime, current: StarMapCanvasProps) => {
    if (!nodeVisible(node, current.layers, runtime.selectedId) || node.emergence < 0.035) return;
    const unrelated = runtime.selectedId && !runtime.litNodes.has(node.data.id) && !node.inLinearScene;
    let alpha = node.emergence * (unrelated ? 0.2 : 1);
    if (runtime.morph > 0.05 && !node.inLinearScene) alpha *= Math.max(0, 1 - runtime.morph * 1.25);
    if (alpha < 0.025) return;
    const rgb = statusRGB(node.data);
    const isClosed = closed(node.data);
    const isSun = node.data.depth === 0 && node.data.childrenIds.length > 0 && !isClosed;
    const m = node.inLinearScene ? runtime.morph : 0;
    const r = node.r;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (node.veil > 0.02 && node.data.childrenIds.length && runtime.morph < 0.95) {
      const veil = spritesRef.current!.veil(isSun ? projectRGB(node.data) : rgb);
      const radius = node.data.domainRadius * 1.18;
      ctx.globalAlpha = alpha * node.veil * (1 - runtime.morph) * (isClosed ? 0.18 : 1);
      if (!current.light) ctx.globalCompositeOperation = "screen";
      ctx.drawImage(veil, node.orbX - radius, node.orbY - radius, radius * 2, radius * 2);
      ctx.globalAlpha = alpha;
    }
    const rect = starMapNodeRect(node);
    if (m < 0.56) {
      const sprite = isSun ? spritesRef.current!.sun(projectRGB(node.data)) : spritesRef.current!.orb(rgb, running(node.data) || node.data.childrenIds.length > 0 || node.data.issue.statusCategory === "started", isClosed);
      const spriteRect = starMapSpriteRect(node);
      ctx.drawImage(sprite, spriteRect.x, spriteRect.y, spriteRect.w, spriteRect.h);
    } else {
      const { x, y } = rect;
      roundRect(ctx, x, y, node.w, node.h, r * (1 - m) + 7 * m);
      const gradient = ctx.createLinearGradient(x, y, x, y + node.h);
      gradient.addColorStop(0, current.light ? "rgba(255,255,255,.98)" : "rgba(26,32,46,.94)");
      gradient.addColorStop(1, current.light ? "rgba(248,250,252,.95)" : "rgba(17,21,31,.96)");
      ctx.fillStyle = isClosed ? (current.light ? "rgba(248,250,252,.72)" : "rgba(15,19,28,.72)") : gradient;
      ctx.fill();
      ctx.strokeStyle = current.light ? "rgba(15,23,42,.14)" : "rgba(226,232,240,.16)";
      ctx.lineWidth = 1 / runtime.camera.zoom;
      if (node.target && (node.target.w < 248 || node.data.issue.role === "context")) ctx.setLineDash([4 / runtime.camera.zoom, 3 / runtime.camera.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (m < 0.5) {
      if (node.data.issue.status === "in_review") {
        ctx.strokeStyle = rgba(VIOLET, 0.65);
        ctx.lineWidth = 1 / runtime.camera.zoom;
        ctx.beginPath(); ctx.arc(node.x, node.y, r + 3.6 / runtime.camera.zoom, 0, TAU); ctx.stroke();
      } else if (node.data.issue.status === "blocked") {
        ctx.strokeStyle = rgba(ORANGE, 0.8);
        ctx.lineWidth = 1.3 / runtime.camera.zoom;
        ctx.beginPath(); ctx.arc(node.x, node.y, r + 4 / runtime.camera.zoom, -0.3 * Math.PI, 0.3 * Math.PI); ctx.stroke();
        ctx.beginPath(); ctx.arc(node.x, node.y, r + 4 / runtime.camera.zoom, 0.7 * Math.PI, 1.3 * Math.PI); ctx.stroke();
      }
      if (running(node.data)) {
        const angle = runtime.orbitalTime * 2.1 + node.data.index;
        ctx.fillStyle = rgba(GREEN, 0.95);
        ctx.beginPath(); ctx.arc(node.x + Math.cos(angle) * (r + 4 / runtime.camera.zoom), node.y + Math.sin(angle) * (r + 4 / runtime.camera.zoom), 1.9 / runtime.camera.zoom, 0, TAU); ctx.fill();
      }
      if (runtime.selectedId === node.data.id || runtime.hoverId === node.data.id) {
        ctx.strokeStyle = current.light ? "#0284c7" : "#e0f2fe";
        ctx.lineWidth = 1.2 / runtime.camera.zoom;
        ctx.beginPath(); ctx.arc(node.x, node.y, r + 5 / runtime.camera.zoom, 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
  };

  const drawTypography = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    if (runtime.morph > 0.86) return;
    const alpha = 1 - smoothstep(0.14, 0.44, runtime.morph);
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    const fits = (x: number, y: number, w: number, h: number) => {
      const rightInset = current.peekOpen ? 548 : 16;
      if (x - w / 2 < 12 || x + w / 2 > runtime.width - rightInset || y - h / 2 < 54 || y + h / 2 > runtime.height - 54) return false;
      return !occupied.some((box) => Math.abs(x - box.x) < (w + box.w) * 0.5 && Math.abs(y - box.y) < (h + box.h) * 0.54);
    };
    for (const guide of current.hierarchy.sectorGuides) {
      const x = guide.kind === "cluster" ? guide.cx : Math.cos(guide.mid) * guide.outerR;
      const y = guide.kind === "cluster" ? guide.cy - guide.radius : Math.sin(guide.mid) * guide.outerR;
      const sx = x * runtime.camera.zoom + runtime.camera.x, sy = y * runtime.camera.zoom + runtime.camera.y;
      ctx.font = `550 13px ${SANS}`;
      const width = ctx.measureText(guide.sector.title).width + 22;
      if (!fits(sx, sy, width, 21)) continue;
      occupied.push({ x: sx, y: sy, w: width, h: 21 });
      ctx.globalAlpha = alpha * 0.86;
      roundRect(ctx, sx - width / 2, sy - 10.5, width, 21, 6);
      ctx.fillStyle = current.light ? "rgba(244,246,249,.88)" : "rgba(8,10,15,.8)";
      ctx.fill();
      ctx.fillStyle = current.light ? "#334155" : "#cbd5e1";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(guide.sector.title, sx, sy + 0.5);
    }
    const labels: RuntimeNode[] = [];
    for (const node of runtime.nodes) {
      if (!nodeVisible(node, current.layers, runtime.selectedId) || node.emergence < 0.18) continue;
      const sx = node.x * runtime.camera.zoom + runtime.camera.x;
      const sy = node.y * runtime.camera.zoom + runtime.camera.y;
      const rPx = node.r * runtime.camera.zoom;
      if (sx < -40 || sx > runtime.width + 40 || sy < 30 || sy > runtime.height + 30) continue;
      if (rPx * 2 >= 19 || runtime.selectedId === node.data.id) {
        const identifier = numericIdentifier(node.data.issue.identifier);
        const fontSize = Math.min(13.5, Math.max(8.2, rPx * (identifier.length >= 4 ? 0.46 : 0.54)));
        ctx.globalAlpha = alpha * node.emergence;
        ctx.font = `650 ${fontSize.toFixed(2)}px ${NUM}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = closed(node.data) ? "#64748b" : node.data.depth === 0 && node.data.childrenIds.length ? "#080a0f" : current.light ? "#334155" : "#e2e8f0";
        ctx.fillText(identifier, sx, sy + 0.35);
      }
      if (node.emergence > 0.48) labels.push(node);
      occupied.push({ x: sx, y: sy, w: rPx * 2 + 8, h: rPx * 2 + 8 });
    }
    labels.sort((a, b) => (Number(runtime.selectedId === b.data.id) - Number(runtime.selectedId === a.data.id)) || a.data.depth - b.data.depth);
    for (const node of labels) {
      const sx = node.x * runtime.camera.zoom + runtime.camera.x;
      const sy = node.y * runtime.camera.zoom + runtime.camera.y;
      const rPx = node.r * runtime.camera.zoom + 7;
      const fontSize = node.data.depth === 0 ? 13.5 : node.data.depth === 1 ? 12.8 : 12.2;
      const title = shortTitle(node.data.issue.title);
      ctx.font = `${node.data.childrenIds.length ? 560 : 460} ${fontSize}px ${SANS}`;
      const width = ctx.measureText(title).width + 14, height = fontSize + 7;
      let placed: StarMapPoint | null = null;
      for (const direction of LABEL_DIRECTIONS) {
        let x = sx, y = sy;
        if (direction === "bottom") y += rPx + height / 2;
        else if (direction === "top") y -= rPx + height / 2;
        else if (direction === "right") x += rPx + width / 2;
        else if (direction === "left") x -= rPx + width / 2;
        else {
          x += (direction.endsWith("right") ? 1 : -1) * (rPx * 0.72 + width / 2);
          y += (direction.startsWith("bottom") ? 1 : -1) * (rPx * 0.72 + height / 2);
        }
        if (fits(x, y, width, height)) { placed = { x, y }; break; }
      }
      if (!placed && runtime.selectedId === node.data.id) placed = { x: sx, y: sy + rPx + height / 2 };
      if (!placed) continue;
      occupied.push({ x: placed.x, y: placed.y, w: width, h: height });
      ctx.globalAlpha = alpha * node.emergence;
      if (node.veil > 0.2 || runtime.selectedId === node.data.id) {
        roundRect(ctx, placed.x - width / 2, placed.y - height / 2, width, height, 6);
        ctx.fillStyle = current.light ? "rgba(255,255,255,.8)" : "rgba(8,10,15,.68)";
        ctx.fill();
      }
      ctx.fillStyle = closed(node.data) ? "#64748b" : current.light ? (node.data.childrenIds.length ? "#0f172a" : "#334155") : (node.data.childrenIds.length ? "#f8fafc" : "#cbd5e1");
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(title, placed.x, placed.y);
    }
    ctx.globalAlpha = 1;
  };

  const drawCardContents = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    const target = runtime.target!;
    const alpha = smoothstep(0.54, 0.88, runtime.morph);
    const { camera } = runtime;
    for (const input of target.plan.input.frames) {
      const box = target.geometry.frames[input.id];
      if (!box) continue;
      const frame = target.model.kind === "line"
        ? target.model.line.frames.find((candidate) => candidate.id === input.modelId)
        : target.model.focus.groups.flatMap((group) => group.frames).find((candidate) => candidate.id === input.modelId);
      if (!frame) continue;
      const x = box.x * camera.zoom + camera.x, y = box.y * camera.zoom + camera.y;
      ctx.globalAlpha = alpha;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = `550 ${Math.max(10, 12 * camera.zoom)}px ${SANS}`;
      ctx.fillStyle = current.light ? "#0f172a" : "#e2e8f0";
      const title = `${frame.issue.identifier}  ${shortTitle(frame.issue.title)}`;
      ctx.fillText(title, x + 12 * camera.zoom, y + 25 * camera.zoom, Math.max(80, box.width * camera.zoom - 150 * camera.zoom));
      ctx.textAlign = "right";
      ctx.fillStyle = current.light ? "#64748b" : "#94a3b8";
      ctx.fillText(`${frame.progress.completed} / ${frame.progress.total}`, x + (box.width - 16) * camera.zoom, y + 25 * camera.zoom);
      if (box.stageMode === "columns") {
        ctx.textAlign = "left";
        ctx.font = `550 ${Math.max(9, 11 * camera.zoom)}px ${SANS}`;
        for (const band of box.bands) ctx.fillText(`Stage ${band.stage}`, x + (band.start - box.x + 12) * camera.zoom, y + (DAG_GROUP_HEADER_HEIGHT + 19) * camera.zoom);
      }
    }
    for (const node of runtime.nodes) {
      if (!node.inLinearScene || !node.target) continue;
      const x = (node.x - node.w / 2) * camera.zoom + camera.x;
      const y = (node.y - node.h / 2) * camera.zoom + camera.y;
      const w = node.w * camera.zoom, h = node.h * camera.zoom;
      if (w < 40 || h < 24) continue;
      const pad = Math.max(5, 10 * camera.zoom);
      ctx.globalAlpha = alpha;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.font = `500 ${Math.max(9, 11 * camera.zoom)}px ${SANS}`;
      ctx.fillStyle = current.light ? "#475569" : "#94a3b8";
      ctx.fillText(node.data.issue.identifier, x + pad, y + pad, w - pad * 2);
      ctx.font = `500 ${Math.max(10, 12 * camera.zoom)}px ${SANS}`;
      ctx.fillStyle = current.light ? "#0f172a" : "#e2e8f0";
      const title = shortTitle(node.data.issue.title);
      ctx.fillText(title, x + pad, y + pad + Math.max(15, 20 * camera.zoom), w - pad * 2);
      if (h > 70) {
        ctx.font = `450 ${Math.max(9, 10 * camera.zoom)}px ${SANS}`;
        ctx.fillStyle = current.light ? "#64748b" : "#94a3b8";
        const footer = node.data.issue.stage ? `Stage ${node.data.issue.stage}` : "";
        ctx.fillText(footer, x + pad, y + h - pad - Math.max(12, 15 * camera.zoom), w - pad * 2);
      }
      if (!closed(node.data)) {
        ctx.fillStyle = rgba(statusRGB(node.data), 0.8);
        ctx.fillRect(x, y + pad, Math.max(1.5, 2 * camera.zoom), h - pad * 2);
      }
    }
    ctx.globalAlpha = 1;
  };

  const drawPreview = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    if (current.phase !== "orbital" || !runtime.previewId || runtime.morph > 0.08) return;
    const node = runtime.byId.get(runtime.previewId);
    if (!node || !nodeVisible(node, current.layers, runtime.selectedId)) return;
    const root = runtime.byId.get(node.data.rootId) ?? node;
    const useChain = current.intent === "chain" || root.data.childrenIds.length === 0;
    const target = useChain ? node : root;
    const sx = target.x * runtime.camera.zoom + runtime.camera.x;
    const sy = target.y * runtime.camera.zoom + runtime.camera.y;
    const radius = useChain ? target.r * runtime.camera.zoom + 11 : Math.max(target.r * runtime.camera.zoom + 16, target.data.domainRadius * runtime.camera.zoom);
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.strokeStyle = current.light ? "rgba(2,132,199,.46)" : "rgba(125,211,252,.46)";
    ctx.lineWidth = 1.15;
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(sx, sy, radius, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    if (runtime.camera.zoom >= 0.48 || Math.hypot(runtime.cursor.x - sx, runtime.cursor.y - sy) < 170) {
      const hint = tRef.current(($) => $.star_map.prefocus, {
        identifier: target.data.issue.identifier,
        mode: useChain ? tRef.current(($) => $.star_map.dependency_chain) : tRef.current(($) => $.star_map.line_cards),
      });
      ctx.font = `500 11px ${SANS}`;
      const width = ctx.measureText(hint).width + 18, height = 24;
      const x = Math.max(16 + width / 2, Math.min(runtime.width - (current.peekOpen ? 548 : 16) - width / 2, sx));
      const y = Math.max(62, Math.min(runtime.height - 66, sy - radius - 16));
      roundRect(ctx, x - width / 2, y - height / 2, width, height, 12);
      ctx.fillStyle = current.light ? "rgba(255,255,255,.92)" : "rgba(12,16,24,.88)";
      ctx.fill();
      ctx.strokeStyle = current.light ? "rgba(2,132,199,.3)" : "rgba(125,211,252,.32)";
      ctx.stroke();
      ctx.fillStyle = current.light ? "#0369a1" : "#bae6fd";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(hint, x, y + 0.5);
    }
    ctx.restore();
  };

  const drawTooltip = (ctx: CanvasRenderingContext2D, runtime: Runtime, current: StarMapCanvasProps) => {
    if (runtime.morph > 0.5) return;
    const node = runtime.hoverId ? runtime.byId.get(runtime.hoverId) : null;
    const edge = runtime.hoverEdgeId ? current.hierarchy.edges.find((candidate) => candidate.id === runtime.hoverEdgeId) : null;
    if (!node && !edge) return;
    const title = node
      ? `${node.data.issue.identifier} · ${node.data.issue.title}`
      : `${runtime.byId.get(edge!.source)?.data.issue.identifier ?? edge!.source} → ${runtime.byId.get(edge!.target)?.data.issue.identifier ?? edge!.target}`;
    const meta = node
      ? `${node.data.issue.status}${node.data.issue.stage ? ` · Stage ${node.data.issue.stage}` : ""}`
      : edge!.kind === "manual"
        ? tRef.current(($) => $.star_map.manual_hint)
        : edge!.kind === "wakeup"
          ? `${tRef.current(($) => $.star_map.wakeup_hint)}${edge!.untilState ? ` · until ${edge!.untilState}` : ""}`
          : tRef.current(($) => $.star_map.mention_hint);
    ctx.save();
    ctx.font = `500 12px ${SANS}`;
    const width = Math.min(360, Math.max(ctx.measureText(title).width, ctx.measureText(meta).width) + 24);
    const x = Math.min(runtime.width - width - 16, runtime.cursor.x + 16), y = Math.min(runtime.height - 74, runtime.cursor.y + 16);
    roundRect(ctx, x, y, width, 58, 9);
    ctx.fillStyle = current.light ? "rgba(255,255,255,.94)" : "rgba(13,17,26,.94)";
    ctx.fill();
    ctx.strokeStyle = current.light ? "rgba(15,23,42,.12)" : "rgba(255,255,255,.12)";
    ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = current.light ? "#0f172a" : "#e2e8f0";
    ctx.fillText(title, x + 12, y + 19, width - 24);
    ctx.fillStyle = current.light ? "#64748b" : "#94a3b8";
    ctx.fillText(meta, x + 12, y + 40, width - 24);
    ctx.restore();
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>): StarMapPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const world = (screen: StarMapPoint): StarMapPoint => {
    const { camera } = runtimeRef.current!;
    return { x: (screen.x - camera.x) / camera.zoom, y: (screen.y - camera.y) / camera.zoom };
  };
  const hitNode = (screen: StarMapPoint) => {
    const runtime = runtimeRef.current!;
    const point = world(screen);
    let best: RuntimeNode | null = null;
    let bestScore = Infinity;
    for (const node of runtime.nodes) {
      if (!nodeVisible(node, propsRef.current.layers, runtime.selectedId) || node.emergence < 0.25) continue;
      if (runtime.morph > 0.45 && node.inLinearScene) {
        if (Math.abs(point.x - node.x) <= node.w / 2 && Math.abs(point.y - node.y) <= node.h / 2) return node;
      } else {
        const distance = Math.hypot(point.x - node.x, point.y - node.y);
        const score = distance - node.data.depth * 4;
        if (distance <= node.r + 4 / runtime.camera.zoom && score < bestScore) { best = node; bestScore = score; }
      }
    }
    return best;
  };
  const hitEdge = (screen: StarMapPoint) => {
    const runtime = runtimeRef.current!;
    if (runtime.morph > 0.5) return null;
    const point = world(screen);
    const current = propsRef.current;
    for (const edge of current.hierarchy.edges) {
      const appearance = edgeAppearance(edge, runtime, current);
      if (!appearance) continue;
      const { source, target } = appearance;
      const a = { x: source.x, y: source.y }, b = { x: target.x, y: target.y };
      const control = arcControl(a, b, edge);
      for (let i = 1; i <= 10; i++) {
        const sample = quadAt(a, control, b, i / 11);
        if (Math.hypot(point.x - sample.x, point.y - sample.y) <= 6 / runtime.camera.zoom) return edge;
      }
    }
    return null;
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand"
        data-star-map-canvas
        data-peek-target={runtimeRef.current?.hoverId ?? undefined}
        role="region"
        aria-label={t(($) => $.star_map.canvas_label)}
        tabIndex={0}
        onPointerDown={(event) => {
          const runtime = runtimeRef.current!;
          const screen = point(event);
          runtime.cursor = { ...screen, inside: true };
          runtime.down = screen;
          runtime.cameraGoal = null;
          const hit = hitNode(screen);
          if (hit && (propsRef.current.linking || event.shiftKey)) {
            runtime.linkSource = hit.data.id;
          } else {
            runtime.panning = { x: screen.x, y: screen.y, cameraX: runtime.camera.x, cameraY: runtime.camera.y };
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const runtime = runtimeRef.current!;
          const screen = point(event);
          runtime.cursor = { ...screen, inside: true };
          if (runtime.panning && runtime.down && Math.hypot(screen.x - runtime.down.x, screen.y - runtime.down.y) >= 4) {
            const raw = {
              x: runtime.panning.cameraX + screen.x - runtime.panning.x,
              y: runtime.panning.cameraY + screen.y - runtime.panning.y,
              zoom: runtime.camera.zoom,
            };
            if (runtime.target && runtime.morph > 0.45) {
              const bounded = clampStarMapCamera(raw, targetBounds(runtime.target), { width: runtime.width, height: runtime.height }, {
                insets: insets(propsRef.current.peekOpen), minZoom: 0.05, maxZoom: 2.2, fill: 0.94,
              });
              raw.x = bounded.x;
              raw.y = bounded.y;
            }
            runtime.camera = raw;
            runtime.hoverId = null;
            runtime.hoverEdgeId = null;
            return;
          }
          const hit = hitNode(screen);
          runtime.hoverId = hit?.data.id ?? null;
          runtime.hoverEdgeId = hit ? null : hitEdge(screen)?.id ?? null;
          event.currentTarget.style.cursor = runtime.linkSource ? "crosshair" : hit || runtime.hoverEdgeId ? "pointer" : runtime.panning ? "grabbing" : "grab";
        }}
        onPointerLeave={() => {
          const runtime = runtimeRef.current!;
          runtime.cursor.inside = false;
          runtime.hoverId = null;
          runtime.hoverEdgeId = null;
        }}
        onPointerUp={(event) => {
          const runtime = runtimeRef.current!;
          const screen = point(event);
          const moved = runtime.down ? Math.hypot(screen.x - runtime.down.x, screen.y - runtime.down.y) : 0;
          if (runtime.linkSource) {
            const source = runtime.linkSource;
            const target = hitNode(screen);
            runtime.linkSource = null;
            if (target && target.data.id !== source) propsRef.current.onAddBlocker(source, target.data.id);
          } else if (moved < 5 && event.detail <= 1) {
            const hit = hitNode(screen);
            if (hit) selectNode(hit.data.id);
            else {
              const edge = hitEdge(screen);
              if (edge?.kind === "manual") propsRef.current.onRemoveBlocker(edge.source, edge.target);
              else selectNode(null);
            }
          }
          runtime.panning = null;
          runtime.down = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onDoubleClick={(event) => {
          const runtime = runtimeRef.current!;
          const hit = hitNode(point(event));
          if (hit) {
            selectNode(hit.data.id);
            if (runtime.morph < 0.7) propsRef.current.onRequestScene(hit.data.id, propsRef.current.intent);
            else propsRef.current.onOpenIssue(hit.data.id);
          } else if (runtime.morph < 0.7) {
            const nearest = nearestStarMapNode(runtime.nearestNodes, runtime.positions, runtime.cursor, runtime.camera.zoom);
            if (nearest) propsRef.current.onRequestScene(nearest.node.id, propsRef.current.intent);
          }
        }}
        onKeyDown={(event) => {
          const runtime = runtimeRef.current!;
          if (event.key === "Escape") selectNode(null);
          else if (event.key === " " && (runtime.hoverId || runtime.selectedId)) propsRef.current.onOpenIssue(runtime.hoverId ?? runtime.selectedId!);
          else if (event.key === "Enter" && runtime.selectedId) propsRef.current.onRequestScene(runtime.selectedId, propsRef.current.intent);
          else if ((event.key === "o" || event.key === "O") && runtime.selectedId) propsRef.current.onOpenIssue(runtime.selectedId);
          else if (event.key === "+" || event.key === "=") runtime.cameraGoal = { ...runtime.camera, zoom: Math.min(2.2, runtime.camera.zoom * 1.2) };
          else if (event.key === "-") runtime.cameraGoal = { ...runtime.camera, zoom: Math.max(0.12, runtime.camera.zoom / 1.2) };
          else return;
          event.preventDefault();
        }}
      />
      <span ref={liveRef} className="sr-only" aria-live="polite" />
    </>
  );
}
