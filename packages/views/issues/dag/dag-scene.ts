export interface DagPoint {
  x: number;
  y: number;
}
export interface DagStageBand {
  stage: number;
  start: number;
  end: number;
}
/** Geometry-only node shape shared with the stage-preference helpers. */
export interface DagLayoutNodeInput {
  id: string;
  width: number;
  height: number;
  groupId?: string | null;
  stage?: number | null;
}
export interface DagLayoutGroupInput {
  id: string;
  parentId: string | null;
  collapsed: boolean;
  independent: boolean;
}
export interface DagLayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}

export type DagSceneKind = "overview" | "line" | "focus";
export type DagSceneSide = "upstream" | "current" | "downstream";
export interface DagSceneNode {
  id: string;
  parentId: string | null;
  width: number;
  height: number;
  stage: number | null;
  side?: DagSceneSide;
}
export interface DagSceneFrame {
  id: string;
  /** Multiple focus fragments can represent the same task line. */
  modelId: string;
  parentId: string | null;
  side?: DagSceneSide;
}
export interface DagSceneEdge {
  id: string;
  source: string;
  target: string;
  sourceKind: "task" | "frame";
  targetKind: "task" | "frame";
}
/** Only fields that change geometry cross the worker boundary / enter the LRU. */
export interface DagSceneInput {
  kind: DagSceneKind;
  id: string;
  nodes: DagSceneNode[];
  frames: DagSceneFrame[];
  edges: DagSceneEdge[];
  grid?: boolean;
}
export interface DagScenePlan {
  input: DagSceneInput;
  /** Scene edge -> original dependency IDs, including mixed bundles. */
  dependencyIds: Record<string, string[]>;
  /** Fully satisfied overview edges never influence node placement. */
  overlays: DagSceneEdge[];
  overlayDependencyIds: Record<string, string[]>;
}
export interface DagSceneBox extends DagPoint {
  width: number;
  height: number;
}
export interface DagSceneFrameBox extends DagSceneBox {
  bands: DagStageBand[];
  stageMode: "columns" | "labels";
}
export interface DagSceneSegment {
  id: string;
  start: DagPoint;
  end: DagPoint;
  /** All scene edges occupying this interval, regardless of endpoints/direction.
   * Resolve through the current plan, never through a cached status. */
  edgeIds: string[];
}
export interface DagSceneJunction extends DagPoint {
  edgeIds: string[];
}
export interface DagSceneGeometry {
  nodes: Record<string, DagSceneBox>;
  frames: Record<string, DagSceneFrameBox>;
  /** Absolute coordinates; precisely one input and output per card/frame. */
  ports: Record<string, { input: DagPoint; output: DagPoint }>;
  /** Ordered per-edge paths retain direction for arrows and selected animations. */
  routes: Record<string, DagPoint[]>;
  segments: DagSceneSegment[];
  junctions: DagSceneJunction[];
  width: number;
  height: number;
  quality: "elk" | "grid" | "fallback";
}

export function dagSceneKey(input: DagSceneInput): string {
  // Full content avoids hash collisions. Array order is the model preference.
  return JSON.stringify([
    input.kind, input.id, Boolean(input.grid),
    input.nodes.map((n) => [n.id, n.parentId, n.width, n.height, n.stage, n.side ?? null]),
    input.frames.map((f) => [f.id, f.modelId, f.parentId, f.side ?? null]),
    input.edges.map((e) => [e.id, e.source, e.target, e.sourceKind, e.targetKind]),
  ]);
}
