/**
 * Deterministic synthetic issue-graph documents for the DAG redo (OL-278).
 *
 * The output is byte-identical for a given dataset name: every choice comes
 * from a seeded PRNG, so unit tests, e2e/perf scenarios and future
 * implementation tasks all measure against the same graph. The shape follows
 * OL-183's simulated game project and OL-184's stress profile: six projects
 * chained by production flow (tooling → art / server / audio → client →
 * level), task lines of 30–40 issues with 2–3 sub-line layers, 1–2 in-line
 * prerequisites per task plus ~20% cross-line prerequisites (always down the
 * production flow), a work frontier per line, fully-completed lines (hidden
 * by default), and the "cancelled-but-still-blocking" case.
 *
 * Two backend rules the wire data must obey (the real endpoint refuses the
 * graph otherwise — see server/internal/issuedependency/model.go Validate
 * and server/internal/service/issue_graph.go):
 *   - no edge may connect an ancestor and a descendant (in-line
 *     prerequisites therefore only link leaf tasks of the same line);
 *   - the response lists nodes, edges and projects sorted by id, and a
 *     node's dependency_summary counts unique unfinished prerequisites of
 *     the node AND its ancestors (only `done` satisfies; cancelled keeps
 *     blocking).
 *
 * Pure TypeScript on purpose: no zod, no node: imports, so the same file can
 * run in a browser-context vitest suite and be bundled into a Playwright spec.
 */

export const ISSUE_GRAPH_FIXTURE_VERSION = "2.1.0";

export type IssueGraphFixtureDatasetName =
  | "accept-5000"
  | "stress-5000"
  | "1000"
  | "2500"
  | "10000"
  | "big-line"
  /** Harness self-check dataset: no nodes, the scenario must report `invalid`. */
  | "empty";

/** How far along a line's task sequence the work has progressed. */
export interface IssueGraphFixtureProfile {
  /** Share of lines that are entirely completed (hidden by default). */
  doneLineShare: number;
  /** Per active line, the seeded range of the completed prefix ratio. */
  lineDoneRatio: [number, number];
  /** Share of an active line's tasks sitting in the active frontier zone. */
  frontierShare: number;
  /** Share of an active line's tail tasks sprinkled as cancelled. */
  cancelledShare: number;
  /** Overall share of leaf tasks carrying one cross-line prerequisite. */
  crossLineShare: number;
}

export interface IssueGraphFixtureConfig {
  name: string;
  /** Exact total node count, containers included. */
  totalTasks: number;
  /** One line holding every task (big-line). */
  singleLine?: boolean;
  profile: IssueGraphFixtureProfile;
  seed: string;
}

/** OL-184's stress shape: ~48% of tasks not finished, most lines active. */
const STRESS_PROFILE: IssueGraphFixtureProfile = {
  doneLineShare: 0.1,
  lineDoneRatio: [0.3, 0.65],
  frontierShare: 0.14,
  cancelledShare: 0.02,
  crossLineShare: 0.21,
};

/** OL-183's acceptance shape: at most 800 of 5,000 tasks unfinished. */
const ACCEPT_PROFILE: IssueGraphFixtureProfile = {
  doneLineShare: 0.58,
  lineDoneRatio: [0.55, 0.85],
  frontierShare: 0.18,
  cancelledShare: 0.02,
  crossLineShare: 0.21,
};

export const ISSUE_GRAPH_FIXTURE_DATASETS: Record<
  IssueGraphFixtureDatasetName,
  IssueGraphFixtureConfig
> = {
  "accept-5000": { name: "accept-5000", totalTasks: 5_000, profile: ACCEPT_PROFILE, seed: "dag-accept-5000-v1" },
  "stress-5000": { name: "stress-5000", totalTasks: 5_000, profile: STRESS_PROFILE, seed: "dag-stress-5000-v1" },
  "1000": { name: "1000", totalTasks: 1_000, profile: STRESS_PROFILE, seed: "dag-scale-1000-v1" },
  "2500": { name: "2500", totalTasks: 2_500, profile: STRESS_PROFILE, seed: "dag-scale-2500-v1" },
  "10000": { name: "10000", totalTasks: 10_000, profile: STRESS_PROFILE, seed: "dag-scale-10000-v1" },
  "big-line": { name: "big-line", totalTasks: 1_000, singleLine: true, profile: STRESS_PROFILE, seed: "dag-big-line-v1" },
  "empty": { name: "empty", totalTasks: 0, profile: STRESS_PROFILE, seed: "dag-empty" },
};

// ---------------------------------------------------------------------------
// Wire types (snake_case, exactly what GET /api/workspaces/:id/issues/graph
// returns; see packages/core/api/issue-graph-schemas.ts).
// ---------------------------------------------------------------------------

export interface SyntheticGraphRunSummary {
  queued: number;
  dispatched: number;
  running: number;
  waiting_local_directory: number;
  captured_at: string;
}

export interface SyntheticGraphNode {
  id: string;
  identifier: string;
  title: string;
  status: string;
  status_category: string;
  revision: number;
  parent_issue_id: string | null;
  has_restricted_parent: boolean;
  project_id: string | null;
  stage: number | null;
  priority: string;
  assignee: { id: string; type: string } | null;
  role: "match" | "context";
  run_summary: SyntheticGraphRunSummary | null;
  dependency_summary: {
    visible_unsatisfied_count: number;
    has_restricted_blockers: boolean;
    dependency_version: string;
  } | null;
}

export interface SyntheticGraphEdge {
  source_edge_id: string;
  source: string;
  target: string;
  type: "blocked_by";
}

export interface SyntheticIssueGraph {
  schema_version: 1;
  snapshot_id: string;
  topology_id: string;
  captured_at: string;
  complete: true;
  scope: { type: "workspace" | "project"; project_id: string | null };
  focus_issue_id: string | null;
  matched_count: number;
  context_count: number;
  nodes: SyntheticGraphNode[];
  edges: SyntheticGraphEdge[];
  projects: { id: string; title: string }[];
  has_restricted_context: boolean;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32 over a string seed). Deterministic across engines.
// ---------------------------------------------------------------------------

function seedToInt(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: string) {
    this.state = seedToInt(seed) || 1;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** Deterministic uuid-shaped id; format only — nothing parses it as a v4. */
  uuid(): string {
    const hex = (n: number) =>
      Array.from({ length: n }, () => "0123456789abcdef"[this.int(0, 15)]).join("");
    return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  }
  hex64(): string {
    const half = () => (seedToInt(this.uuid()) >>> 0).toString(16).padStart(8, "0");
    return half() + half() + half() + half() + half() + half() + half() + half();
  }
}

/**
 * Split `total` into exactly `parts` integers in [min, max]. `parts` is
 * clamped to what the bounds allow; callers must read the returned length to
 * learn the actual group count and reconcile any totals from it.
 */
function spread(rng: Rng, total: number, parts: number, min: number, max: number): number[] {
  const size = Math.min(Math.max(parts, Math.ceil(total / max)), Math.floor(total / min));
  // No group count satisfies the bounds (e.g. 85 tasks into 30-40 lines):
  // refuse instead of looping forever below.
  if (!(size >= 1 && size * max >= total && size * min <= total)) {
    throw new Error(`infeasible spread bounds: total=${total} min=${min} max=${max}`);
  }
  const sizes = Array.from({ length: size }, () => Math.floor(total / size));
  let remainder = total - sizes.reduce((a, b) => a + b, 0);
  let i = 0;
  while (remainder > 0) {
    const at = i % size;
    if (sizes[at]! < max) { sizes[at]! += 1; remainder -= 1; }
    i += 1;
  }
  for (let a = sizes.length - 1; a > 0; a--) {
    const b = rng.int(0, a - 1);
    const room = Math.min(max - sizes[a]!, sizes[b]! - min);
    if (room <= 0) continue;
    const move = rng.int(0, room);
    sizes[a]! += move;
    sizes[b]! -= move;
  }
  return sizes;
}

/** Split `total` into EXACTLY `parts` positive integers, no bounds. The
 * caller guarantees parts <= total. Used where the group count is fixed by
 * containers already created and must not be clamped. */
function evenSplit(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const sizes = Array.from({ length: parts }, () => base);
  let remainder = total - base * parts;
  let i = 0;
  while (remainder > 0) {
    sizes[i % parts]! += 1;
    remainder -= 1;
    i += 1;
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// Content banks — a game studio in the OL-183 sense. `flow` is the position
// in the production pipeline; cross-line dependencies always point down-flow.
// ---------------------------------------------------------------------------

interface ProjectBank {
  title: string;
  flow: 0 | 1 | 2 | 3;
  lines: string[];
  tasks: string[];
}

const PROJECT_BANKS: ProjectBank[] = [
  {
    title: "Tooling",
    flow: 0,
    lines: ["Build pipeline", "Asset importer", "Editor tooling", "CI automation", "Release tooling", "Perforce bridge"],
    tasks: ["compile shader cache", "validate asset manifest", "snapshot editor layout", "retry flaky job", "package build artifacts", "sync workspace mapping", "audit import queue", "warm dependency cache", "gate unstable revision", "archive stale branches"],
  },
  {
    title: "Art",
    flow: 1,
    lines: ["Character art", "Environment art", "VFX library", "Animation set", "UI art", "Concept board"],
    tasks: ["sculpt high-poly mesh", "retopologize model", "paint texture set", "bind skeleton rig", "author blend shapes", "tune material graph", "bake ambient occlusion", "review silhouette pass", "export LOD chain", "fix texel density"],
  },
  {
    title: "Server",
    flow: 1,
    lines: ["Matchmaking service", "Inventory service", "Progression service", "Social service", "Shop service", "Telemetry pipeline"],
    tasks: ["design request schema", "implement handler", "write storage migration", "add cache invalidation", "wire retry policy", "shadow traffic replay", "load test endpoint", "harden rate limit", "document error codes", "rotate service credentials"],
  },
  {
    title: "Audio",
    flow: 1,
    lines: ["SFX banks", "Ambient beds", "Voiceover pass", "Music stems", "Mix bus", "Dialogue system"],
    tasks: ["record source takes", "edit and trim clips", "design layered impact", "mix bus balance", "hook audio trigger", "subtitle timing pass", "compress bank build", "localize dialogue takes", "ducking curve pass", "audit clipping peaks"],
  },
  {
    title: "Client",
    flow: 2,
    lines: ["Input system", "Renderer frame", "UI screens", "Netcode client", "Gameplay framework", "Settings & accessibility"],
    tasks: ["map gamepad bindings", "reduce draw calls", "implement screen transition", "predict remote movement", "reconcile snapshot delta", "pool widget instances", "fix shader permutation", "profile frame spike", "localize string table", "support remapping presets"],
  },
  {
    title: "Level",
    flow: 3,
    lines: ["Onboarding level", "Combat arena", "Hub world", "Story mission set", "Endgame dungeon", "Tutorial sandbox"],
    tasks: ["block out level geometry", "script sequence trigger", "tune encounter pacing", "place lighting rig", "bake navigation mesh", "wire checkpoint flow", "balance reward curve", "set dressing pass", "optimize occlusion", "run playtest session"],
  },
];

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
const MEMBER_IDS = ["5eeeeeee-0000-4000-8000-000000000001", "5eeeeeee-0000-4000-8000-000000000002"];
const AGENT_IDS = ["6eeeeeee-0000-4000-8000-000000000001", "6eeeeeee-0000-4000-8000-000000000002"];
const CAPTURED_AT = "2026-10-01T00:00:00.000Z";

// Status keys are the seven built-ins; categories follow the four-value
// lifecycle mapping the view normalizes through anyway.
const STATUS_CATEGORY: Record<string, string> = {
  backlog: "unstarted",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  done: "done",
  cancelled: "closed",
};

/** Only a `done` status satisfies a prerequisite (backend rule). */
const satisfied = (status: string) => status === "done";
const unfinishedStatus = (status: string) => status !== "done" && status !== "cancelled";

// ---------------------------------------------------------------------------
// Builder state
// ---------------------------------------------------------------------------

interface LineContext {
  projectId: string;
  projectIndex: number;
  /** Line root plus every sub-line container, creation order. */
  containers: SyntheticGraphNode[];
  root: SyntheticGraphNode;
  /** Leaf tasks in topological order. */
  leaves: SyntheticGraphNode[];
  fullyDone: boolean;
}

interface Builder {
  rng: Rng;
  config: IssueGraphFixtureConfig;
  nodes: SyntheticGraphNode[];
  edges: SyntheticGraphEdge[];
  projects: { id: string; title: string; flow: 0 | 1 | 2 | 3 }[];
  lines: LineContext[];
  identifier: number;
  edgePairs: Set<string>;
}

function makeNode(
  builder: Builder,
  parentId: string | null,
  projectId: string,
  title: string,
): SyntheticGraphNode {
  builder.identifier += 1;
  const node: SyntheticGraphNode = {
    id: builder.rng.uuid(),
    identifier: `GAME-${builder.identifier}`,
    title,
    status: "todo",
    status_category: STATUS_CATEGORY.todo!,
    revision: 1,
    parent_issue_id: parentId,
    has_restricted_parent: false,
    project_id: projectId,
    stage: null,
    priority: builder.rng.pick(PRIORITIES),
    assignee: null,
    role: "match",
    run_summary: {
      queued: 0, dispatched: 0, running: 0, waiting_local_directory: 0,
      captured_at: CAPTURED_AT,
    },
    dependency_summary: null,
  };
  builder.nodes.push(node);
  return node;
}

function addEdge(builder: Builder, source: string, target: string): void {
  const pair = `${source}->${target}`;
  if (source === target || builder.edgePairs.has(pair)) return;
  builder.edgePairs.add(pair);
  builder.edges.push({
    source_edge_id: builder.rng.uuid(),
    source,
    target,
    type: "blocked_by",
  });
}

// ---------------------------------------------------------------------------
// Line construction — exact node totals, 2–3 sub-line layers
// ---------------------------------------------------------------------------

/** Build one task line of exactly `size` nodes (root + sub-lines + leaf tasks). */
function buildLine(builder: Builder, size: number, projectId: string, title: string): LineContext {
  const rng = builder.rng;
  const taskBank = PROJECT_BANKS[
    builder.projects.findIndex((p) => p.id === projectId)
  ]!;
  const leafTitle = () => `${rng.pick(taskBank.tasks)} (${builder.identifier})`;
  const subTitle = () => `${rng.pick(["Design", "Implement", "Validate", "Integrate", "Polish", "Ship", "Phase A", "Phase B", "Track 1", "Track 2"])} ${title.toLowerCase()}`;

  const root = makeNode(builder, null, projectId, title);
  const containers = [root];
  const leaves: SyntheticGraphNode[] = [];
  const budget = size - 1;
  // Depth 4 lines (root → sub → subsub → task) use ~1/3 containers; depth 3
  // lines (root → sub → task) ~1/6 — "2–3 sub-line layers" in the brief.
  const deep = budget >= 24 && rng.chance(0.5);
  if (!deep) {
    // Container count first, then leaves fill exactly what is left: the
    // actual sub count is whatever spread() returned, never an assumption.
    const subTarget = Math.max(2, Math.min(8, Math.round(budget / 6)));
    const groups = spread(rng, Math.max(2, budget - subTarget), subTarget, 2, 14);
    const alloc = evenSplit(budget - groups.length, groups.length);
    for (const count of alloc) {
      const sub = makeNode(builder, root.id, projectId, subTitle());
      containers.push(sub);
      for (let i = 0; i < count; i++) {
        leaves.push(makeNode(builder, sub.id, projectId, leafTitle()));
      }
    }
  } else {
    const subCount = Math.max(2, Math.min(4, Math.round(budget / 12)));
    const containerTarget = Math.max(2 * subCount, Math.min(24, Math.round(budget / 6)));
    const subsubsPerSub = spread(rng, containerTarget - subCount, subCount, 1, 8);
    const actualSubsubs = subsubsPerSub.reduce((a, b) => a + b, 0);
    const alloc = evenSplit(budget - subsubsPerSub.length - actualSubsubs, actualSubsubs);
    let leafCursor = 0;
    for (const subsubCount of subsubsPerSub) {
      const sub = makeNode(builder, root.id, projectId, subTitle());
      containers.push(sub);
      for (let s = 0; s < subsubCount; s++) {
        const subsub = makeNode(builder, sub.id, projectId, `${sub.title} — ${rng.pick(["setup", "build", "verify", "harden", "release"])}`);
        containers.push(subsub);
        const count = alloc[leafCursor] ?? 1;
        leafCursor += 1;
        for (let i = 0; i < count; i++) {
          leaves.push(makeNode(builder, subsub.id, projectId, leafTitle()));
        }
      }
    }
  }
  // Stages follow the topological order of the line's tasks (1–6).
  leaves.forEach((leaf, index) => {
    leaf.stage = Math.min(6, 1 + Math.floor((index / leaves.length) * 6));
  });
  return { projectId, projectIndex: 0, containers, root, leaves, fullyDone: false };
}

/** Create every line, round-robin across projects down the production flow. */
function createLines(builder: Builder): void {
  const rng = builder.rng;
  const lineCount = builder.config.singleLine ? 1 : Math.max(6, Math.round(builder.config.totalTasks / 35));
  const lineSizes = builder.config.singleLine
    ? [builder.config.totalTasks]
    : spread(rng, builder.config.totalTasks, lineCount, 30, 40);
  // Flow group by flow group, so every later line can draw cross-line
  // prerequisites from strictly earlier flow groups.
  const flowOrder: number[] = [];
  const flows = [0, 1, 1, 1, 2, 3];
  for (const flow of [0, 1, 2, 3]) {
    for (const projectIndex of PROJECT_BANKS.map((_, i) => i).filter((i) => flows[i] === flow)) {
      flowOrder.push(projectIndex);
    }
  }
  const projectCursor = new Array(PROJECT_BANKS.length).fill(0);
  let built = 0;
  while (built < lineSizes.length) {
    for (const projectIndex of flowOrder) {
      if (built >= lineSizes.length) break;
      const bank = PROJECT_BANKS[projectIndex]!;
      const projectId = builder.projects[projectIndex]!.id;
      const seen = projectCursor[projectIndex]!;
      const name = bank.lines[seen % bank.lines.length]!
        + (seen >= bank.lines.length ? ` ${Math.floor(seen / bank.lines.length) + 1}` : "");
      projectCursor[projectIndex]! += 1;
      const line = buildLine(builder, lineSizes[built]!, projectId, name);
      line.projectIndex = projectIndex;
      builder.lines.push(line);
      built += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/** Statuses along a line's task sequence: done prefix, active frontier, open tail. */
function applyFrontier(builder: Builder, line: LineContext): void {
  const { profile } = builder.config;
  const rng = builder.rng;
  const leaves = line.leaves;
  const doneRatio = profile.lineDoneRatio[0] + rng.next() * (profile.lineDoneRatio[1] - profile.lineDoneRatio[0]);
  const donePrefix = Math.round(leaves.length * doneRatio);
  const zone = Math.max(2, Math.round(leaves.length * profile.frontierShare));
  const frontierStatuses = ["in_progress", "in_progress", "in_review", "blocked"];
  leaves.forEach((leaf, index) => {
    if (index < donePrefix) leaf.status = "done";
    else if (index < donePrefix + zone) leaf.status = rng.pick(frontierStatuses);
    else leaf.status = rng.chance(0.6) ? "backlog" : "todo";
  });
  // Sprinkle cancelled tasks into the open tail: visible dashed cards whose
  // downstream neighbours stay unfinished.
  for (let index = donePrefix + zone; index < leaves.length; index++) {
    if (rng.chance(profile.cancelledShare)) leaves[index]!.status = "cancelled";
  }
  if (!leaves.some((leaf) => leaf.status === "in_progress")) {
    const at = Math.min(donePrefix, leaves.length - 1);
    if (at >= 0) leaves[at]!.status = "in_progress";
  }
}

/** Container/root status derives from descendants, like the real projection. */
function deriveContainerStatuses(line: LineContext): void {
  const byParent = new Map<string | null, SyntheticGraphNode[]>();
  for (const node of [...line.containers, ...line.leaves]) {
    const list = byParent.get(node.parent_issue_id) ?? [];
    list.push(node);
    byParent.set(node.parent_issue_id, list);
  }
  const resolve = (node: SyntheticGraphNode): string => {
    const children = byParent.get(node.id) ?? [];
    if (!children.length) return node.status;
    const childStatuses = children.map(resolve);
    if (childStatuses.every((status) => status === "done")) return "done";
    if (childStatuses.includes("in_progress")) return "in_progress";
    if (childStatuses.includes("in_review")) return "in_review";
    if (childStatuses.includes("blocked")) return "blocked";
    return "todo";
  };
  for (const node of line.containers) node.status = resolve(node);
}

/** Decide which lines are fully completed (hidden by default) and set statuses. */
function assignLineCompletion(builder: Builder): void {
  const { profile } = builder.config;
  const rng = builder.rng;
  // The first line — always tooling, upstream of everything — is forced done
  // so the cancelled-but-still-blocking anchor below has a guaranteed home.
  builder.lines.forEach((line, index) => {
    line.fullyDone = !builder.config.singleLine && (index === 0 || rng.chance(profile.doneLineShare));
  });
  for (const line of builder.lines) {
    if (line.fullyDone) {
      for (const member of [...line.containers, ...line.leaves]) member.status = "done";
    } else {
      applyFrontier(builder, line);
    }
    deriveContainerStatuses(line);
  }
}

/**
 * The cancelled-but-still-blocking case: a cancelled task inside a hidden
 * fully-done line, with a direct dependent in a visible unfinished line
 * further down the production flow.
 */
function addCancelledBlockingAnchor(builder: Builder): void {
  if (builder.config.singleLine) return;
  const anchor = builder.lines[0]!;
  const cancelledLeaf = anchor.leaves[Math.min(2, anchor.leaves.length - 1)]!;
  cancelledLeaf.status = "cancelled";
  cancelledLeaf.status_category = STATUS_CATEGORY.cancelled!;
  const downstream = builder.lines.find(
    (line) => !line.fullyDone && PROJECT_BANKS[line.projectIndex]!.flow >= 2,
  ) ?? builder.lines.find((line) => !line.fullyDone);
  if (!downstream) {
    throw new Error("no unfinished line to anchor the cancelled-blocking case (doneLineShare too high?)");
  }
  const target = downstream.leaves.find((leaf) => unfinishedStatus(leaf.status)) ?? downstream.leaves.at(-1)!;
  addEdge(builder, cancelledLeaf.id, target.id);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * In-line prerequisites: every leaf task after the line's first gets 1–2
 * earlier leaves of the SAME line. Leaves are never ancestors of each other,
 * so no edge can trip the backend's ancestor check; the first task of a line
 * starts without an in-line prerequisite.
 */
function addInLineDependencies(builder: Builder, line: LineContext): void {
  const rng = builder.rng;
  line.leaves.forEach((leaf, index) => {
    if (index === 0) return;
    const candidates: SyntheticGraphNode[] = [line.leaves[index - 1]!];
    const second = rng.pick([
      line.leaves[index - 2] ?? line.leaves[index - 1]!,
      line.leaves[index - 3] ?? line.leaves[index - 1]!,
    ]);
    if (second !== candidates[0]) candidates.push(second);
    if (rng.chance(0.5)) candidates.length = 1;
    for (const prereq of candidates) addEdge(builder, prereq.id, leaf.id);
  });
}

/**
 * Cross-line prerequisites, always down the production flow: a task only
 * depends on tasks from strictly earlier-flow projects, so tooling lines get
 * none. The per-task probability is scaled so the OVERALL share of tasks
 * with a cross-line prerequisite stays at the profile's target.
 */
function addCrossLineDependencies(builder: Builder): void {
  const rng = builder.rng;
  const { profile } = builder.config;
  if (builder.config.singleLine) {
    // No cross-line sources exist; in-line prerequisites still apply.
    for (const line of builder.lines) addInLineDependencies(builder, line);
    return;
  }
  const flowOf = (line: LineContext) => PROJECT_BANKS[line.projectIndex]!.flow;
  const allLeaves = builder.lines.flatMap((line) => line.leaves);
  const eligibleLeaves = builder.lines.filter((line) => flowOf(line) > 0)
    .flatMap((line) => line.leaves).length;
  if (!eligibleLeaves) return;
  const share = Math.min(0.5, (profile.crossLineShare * allLeaves.length) / eligibleLeaves);
  builder.lines.forEach((line, lineIndex) => {
    addInLineDependencies(builder, line);
    const flow = flowOf(line);
    if (flow === 0) return; // nothing upstream of tooling
    const pool = builder.lines.slice(0, lineIndex).filter((earlier) => flowOf(earlier) < flow);
    if (!pool.length) return;
    for (const leaf of line.leaves) {
      if (!rng.chance(share)) continue;
      const sourceLine = rng.pick(pool);
      addEdge(builder, rng.pick(sourceLine.leaves).id, leaf.id);
    }
    // One line-level dependency: the line's root waits on an earlier-flow
    // line's output. The source is a leaf of another tree, never an ancestor.
    if (lineIndex > 0 && rng.chance(profile.crossLineShare)) {
      const sourceLine = rng.pick(pool);
      addEdge(builder, rng.pick(sourceLine.leaves).id, line.root.id);
    }
  });
}

// ---------------------------------------------------------------------------
// Post-pass: run summaries, assignees, dependency summaries, assembly
// ---------------------------------------------------------------------------

function assignRunSummariesAndAssignees(builder: Builder): void {
  const rng = builder.rng;
  for (const node of builder.nodes) {
    node.status_category = STATUS_CATEGORY[node.status]!;
    if (node.status === "in_progress") {
      const roll = rng.next();
      node.run_summary = {
        queued: roll < 0.15 ? 1 : 0,
        dispatched: roll >= 0.15 && roll < 0.3 ? 1 : 0,
        running: roll >= 0.3 ? 1 : 0,
        waiting_local_directory: 0,
        captured_at: CAPTURED_AT,
      };
      node.assignee = { id: rng.pick(AGENT_IDS), type: "agent" };
    } else {
      node.run_summary = {
        queued: 0, dispatched: 0, running: 0, waiting_local_directory: 0,
        captured_at: CAPTURED_AT,
      };
      if (node.status === "in_review" || node.status === "blocked") {
        node.assignee = rng.chance(0.5) ? { id: rng.pick(MEMBER_IDS), type: "member" } : null;
      } else if (node.status === "todo" || node.status === "backlog") {
        node.assignee = rng.chance(0.25) ? { id: rng.pick(MEMBER_IDS), type: "member" } : null;
      }
    }
  }
}

/**
 * Dependency summaries exactly the way the backend computes them: unique
 * direct prerequisites of the node AND its ancestors; a prerequisite is
 * satisfied only by `done` (cancelled keeps blocking — that is the case the
 * DAG redo draws in red).
 */
function assignDependencySummaries(builder: Builder): void {
  const rng = builder.rng;
  const byId = new Map(builder.nodes.map((node) => [node.id, node]));
  const sourcesOf = new Map<string, string[]>();
  for (const edge of builder.edges) {
    const list = sourcesOf.get(edge.target) ?? [];
    list.push(edge.source);
    sourcesOf.set(edge.target, list);
  }
  for (const node of builder.nodes) {
    const closure = new Set<string>();
    let current: string | null = node.id;
    while (current != null) {
      for (const source of sourcesOf.get(current) ?? []) closure.add(source);
      current = byId.get(current)!.parent_issue_id;
    }
    let unsatisfied = 0;
    for (const source of closure) {
      if (!satisfied(byId.get(source)!.status)) unsatisfied += 1;
    }
    node.dependency_summary = {
      visible_unsatisfied_count: unsatisfied,
      has_restricted_blockers: false,
      dependency_version: rng.hex64(),
    };
  }
}

/** Named datasets are generated once per process and reused — they are
 * deterministic, and regenerating 5,000–10,000 nodes per test adds minutes.
 * Cached documents are deep-frozen: every caller shares one object, and a
 * mutation by one test would poison the others silently. */
const namedCache = new Map<string, SyntheticIssueGraph>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildIssueGraphFixture(
  dataset: IssueGraphFixtureDatasetName | IssueGraphFixtureConfig,
): SyntheticIssueGraph {
  const config = typeof dataset === "string" ? ISSUE_GRAPH_FIXTURE_DATASETS[dataset] : dataset;
  const cacheKey = typeof dataset === "string" ? `${dataset}|${config.seed}` : null;
  if (cacheKey && namedCache.has(cacheKey)) return namedCache.get(cacheKey)!;
  const rng = new Rng(config.seed);
  const builder: Builder = {
    rng,
    config,
    nodes: [],
    edges: [],
    projects: PROJECT_BANKS.map((bank) => ({ id: rng.uuid(), title: bank.title, flow: bank.flow })),
    lines: [],
    identifier: 0,
    edgePairs: new Set(),
  };

  if (config.totalTasks === 0) {
    // The empty self-check graph: valid schema, zero nodes.
    return {
      schema_version: 1, snapshot_id: rng.hex64(), topology_id: rng.hex64(),
      captured_at: CAPTURED_AT, complete: true,
      scope: { type: "workspace", project_id: null }, focus_issue_id: null,
      matched_count: 0, context_count: 0, nodes: [], edges: [],
      // A graph with no nodes carries no project context, like the endpoint.
      projects: [],
      has_restricted_context: false,
    };
  }
  createLines(builder);
  assignLineCompletion(builder);
  addCancelledBlockingAnchor(builder);
  addCrossLineDependencies(builder);
  assignRunSummariesAndAssignees(builder);
  assignDependencySummaries(builder);

  // The endpoint lists nodes, edges and projects by id; mirror that order so
  // layout input is no tidier than production data.
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const graph: SyntheticIssueGraph = {
    schema_version: 1,
    snapshot_id: rng.hex64(),
    topology_id: rng.hex64(),
    captured_at: CAPTURED_AT,
    complete: true,
    scope: { type: "workspace", project_id: null },
    focus_issue_id: null,
    matched_count: builder.nodes.length,
    context_count: 0,
    nodes: [...builder.nodes].sort(byId),
    edges: [...builder.edges].sort((a, b) => (a.source_edge_id < b.source_edge_id ? -1 : 1)),
    projects: [...builder.projects].sort(byId).map(({ id, title }) => ({ id, title })),
    has_restricted_context: false,
  };
  if (cacheKey) {
    namedCache.set(cacheKey, deepFreeze(graph));
    return namedCache.get(cacheKey)!;
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Shape statistics — what the unit test asserts and reports carry.
// ---------------------------------------------------------------------------

export interface IssueGraphFixtureStats {
  nodes: number;
  edges: number;
  leaves: number;
  containers: number;
  lines: number;
  lineSizeMin: number;
  lineSizeMax: number;
  fullyDoneLines: number;
  hiddenLineTasks: number;
  /** Tasks not done and not cancelled — OL-183's "unfinished". */
  unfinished: number;
  statuses: Record<string, number>;
  maxDepth: number;
  minDepth: number;
  stagesPresent: number[];
  /** Leaf tasks carrying at least one cross-line prerequisite (target side). */
  crossLineTasks: number;
  crossLineShare: number;
  /** Cross-line edges pointing against the production flow (must be 0). */
  crossLineAgainstFlow: number;
  /** Edges connecting an ancestor and a descendant (must be 0). */
  ancestorEdges: number;
  /** Leaves with no in-line prerequisite (each line's first task). */
  leavesWithoutInlinePrereq: number;
  inlinePrereqMin: number;
  inlinePrereqMax: number;
  inProgressWithoutRunSummary: number;
  inProgressWithoutActiveRun: number;
  /** Cancelled tasks inside fully-done lines that still block unfinished work. */
  cancelledStillBlocking: number;
  acyclic: boolean;
}

/** Rebuild the parent forest and per-node views the statistics need. */
function graphIndex(graph: SyntheticIssueGraph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, SyntheticGraphNode[]>();
  for (const node of graph.nodes) {
    const list = children.get(node.parent_issue_id) ?? [];
    list.push(node);
    children.set(node.parent_issue_id, list);
  }
  const ancestorsOf = (node: SyntheticGraphNode): Set<string> => {
    const chain = new Set<string>();
    let current = node.parent_issue_id;
    while (current != null) {
      chain.add(current);
      current = byId.get(current)!.parent_issue_id;
    }
    return chain;
  };
  return { byId, children, ancestorsOf };
}

export function analyzeIssueGraphFixture(graph: SyntheticIssueGraph): IssueGraphFixtureStats {
  if (!graph.nodes.length) {
    return {
      nodes: 0, edges: 0, leaves: 0, containers: 0, lines: 0,
      lineSizeMin: 0, lineSizeMax: 0, fullyDoneLines: 0, hiddenLineTasks: 0,
      unfinished: 0, statuses: {}, maxDepth: 0, minDepth: 0, stagesPresent: [],
      crossLineTasks: 0, crossLineShare: 0, crossLineAgainstFlow: 0, ancestorEdges: 0,
      leavesWithoutInlinePrereq: 0, inlinePrereqMin: 0, inlinePrereqMax: 0,
      inProgressWithoutRunSummary: 0, inProgressWithoutActiveRun: 0,
      cancelledStillBlocking: 0, acyclic: true,
    };
  }
  const { byId, children, ancestorsOf } = graphIndex(graph);
  const roots = children.get(null) ?? [];
  const lineOf = new Map<SyntheticGraphNode, SyntheticGraphNode>();
  for (const root of roots) {
    const walk = (node: SyntheticGraphNode) => {
      lineOf.set(node, root);
      for (const child of children.get(node.id) ?? []) walk(child);
    };
    walk(root);
  }
  const lineMembers = (root: SyntheticGraphNode) => {
    const members: SyntheticGraphNode[] = [];
    const walk = (node: SyntheticGraphNode) => {
      members.push(node);
      for (const child of children.get(node.id) ?? []) walk(child);
    };
    walk(root);
    return members;
  };

  const statuses: Record<string, number> = {};
  for (const node of graph.nodes) statuses[node.status] = (statuses[node.status] ?? 0) + 1;
  const leaves = graph.nodes.filter((node) => !children.has(node.id));
  const finished = (node: SyntheticGraphNode) =>
    node.status === "done" || node.status === "cancelled";
  const fullyDoneRoots = roots.filter((root) => lineMembers(root).every(finished));
  const hiddenLineTasks = fullyDoneRoots.reduce((sum, root) => sum + lineMembers(root).length, 0);

  // Dependency views: same-line vs cross-line, direction, ancestry.
  const prereqsOf = new Map<string, SyntheticGraphNode[]>();
  for (const edge of graph.edges) {
    const list = prereqsOf.get(edge.target) ?? [];
    list.push(byId.get(edge.source)!);
    prereqsOf.set(edge.target, list);
  }
  // Project flow lives in PROJECT_BANKS; recover it by title.
  const flowByProject = new Map<string, number>();
  for (const project of graph.projects) {
    flowByProject.set(project.id, PROJECT_BANKS.find((b) => b.title === project.title)?.flow ?? -1);
  }
  const flowOf = (line: SyntheticGraphNode) => flowByProject.get(line.project_id ?? "") ?? -1;

  let ancestorEdges = 0;
  let crossLineAgainstFlow = 0;
  let crossLineTasks = 0;
  let leavesWithoutInlinePrereq = 0;
  let inlineMin = Number.POSITIVE_INFINITY;
  let inlineMax = 0;
  for (const leaf of leaves) {
    const prereqs = prereqsOf.get(leaf.id) ?? [];
    const inline = prereqs.filter((p) => lineOf.get(p) === lineOf.get(leaf));
    const cross = prereqs.filter((p) => lineOf.get(p) !== lineOf.get(leaf));
    if (cross.length > 0) crossLineTasks += 1;
    if (inline.length === 0) leavesWithoutInlinePrereq += 1;
    else {
      inlineMin = Math.min(inlineMin, inline.length);
      inlineMax = Math.max(inlineMax, inline.length);
    }
  }
  for (const edge of graph.edges) {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    if (ancestorsOf(source).has(target.id) || ancestorsOf(target).has(source.id)) ancestorEdges += 1;
    if (lineOf.get(source) !== lineOf.get(target)
      && flowOf(lineOf.get(source)!) >= flowOf(lineOf.get(target)!)) {
      crossLineAgainstFlow += 1;
    }
  }

  // Kahn topological check over the directed edge set.
  const downstream = new Map<string, string[]>();
  const indegree = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    const list = downstream.get(edge.source) ?? [];
    list.push(edge.target);
    downstream.set(edge.source, list);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of downstream.get(id) ?? []) {
      const degree = indegree.get(next)! - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  // Cancelled blockers of hidden done lines.
  const hiddenScope = new Set<string>();
  for (const root of fullyDoneRoots) for (const member of lineMembers(root)) hiddenScope.add(member.id);
  let cancelledStillBlocking = 0;
  for (const node of graph.nodes) {
    if (node.status !== "cancelled" || !hiddenScope.has(node.id)) continue;
    const blocks = (downstream.get(node.id) ?? []).some((id) => !finished(byId.get(id)!));
    if (blocks) cancelledStillBlocking += 1;
  }

  const depthOf = (node: SyntheticGraphNode): number => {
    let depth = 1;
    let current = node;
    while (current.parent_issue_id !== null) {
      current = byId.get(current.parent_issue_id)!;
      depth += 1;
    }
    return depth;
  };
  const depths = graph.nodes.map(depthOf);
  const lineSizes = roots.map((root) => lineMembers(root).length);
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    leaves: leaves.length,
    containers: graph.nodes.length - leaves.length,
    lines: roots.length,
    lineSizeMin: Math.min(...lineSizes),
    lineSizeMax: Math.max(...lineSizes),
    fullyDoneLines: fullyDoneRoots.length,
    hiddenLineTasks,
    unfinished: graph.nodes.filter((node) => unfinishedStatus(node.status)).length,
    statuses,
    maxDepth: Math.max(...depths),
    minDepth: Math.min(...depths),
    stagesPresent: [...new Set(leaves.map((leaf) => leaf.stage ?? 0))].sort((a, b) => a - b),
    crossLineTasks,
    crossLineShare: leaves.length ? crossLineTasks / leaves.length : 0,
    crossLineAgainstFlow,
    ancestorEdges,
    leavesWithoutInlinePrereq,
    inlinePrereqMin: Number.isFinite(inlineMin) ? inlineMin : 0,
    inlinePrereqMax: inlineMax,
    inProgressWithoutRunSummary: graph.nodes.filter(
      (node) => node.status === "in_progress" && node.run_summary == null,
    ).length,
    inProgressWithoutActiveRun: graph.nodes.filter((node) => {
      if (node.status !== "in_progress" || !node.run_summary) return false;
      const run = node.run_summary;
      return run.queued + run.dispatched + run.running + run.waiting_local_directory === 0;
    }).length,
    cancelledStillBlocking,
    acyclic: visited === graph.nodes.length,
  };
}

/** FNV-1a over the serialized document — identity for reports, no deps. */
export function issueGraphFixtureDigest(graph: SyntheticIssueGraph): string {
  const text = JSON.stringify(graph);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
