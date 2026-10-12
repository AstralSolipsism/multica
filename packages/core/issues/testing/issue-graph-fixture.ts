/**
 * Deterministic synthetic issue-graph documents for the DAG redo (OL-278).
 *
 * The output is byte-identical for a given dataset name: every choice comes
 * from a seeded PRNG, so unit tests, e2e/perf scenarios and future
 * implementation tasks all measure against the same graph. The shape follows
 * OL-183's simulated game project and OL-184's stress profile: six projects
 * chained by production flow (tooling → art / server / audio → client →
 * level), task lines of 30–40 issues with 2–3 sub-line layers, 1–2 in-line
 * prerequisites per task plus ~20% cross-line prerequisites, a work frontier
 * per line, fully-completed lines (hidden by default), and the
 * "cancelled-but-still-blocking" case.
 *
 * Pure TypeScript on purpose: no zod, no node: imports, so the same file can
 * run in a browser-context vitest suite and be bundled into a Playwright spec.
 * Validation against `IssueGraphSchema` happens in the unit test, not here.
 */

export const ISSUE_GRAPH_FIXTURE_VERSION = "1.0.0";

export type IssueGraphFixtureDatasetName =
  | "accept-5000"
  | "stress-5000"
  | "1000"
  | "2500"
  | "10000"
  | "big-line";

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
  /** Probability per task of one extra cross-line prerequisite. */
  crossLineShare: number;
}

export interface IssueGraphFixtureConfig {
  name: IssueGraphFixtureDatasetName;
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

// ---------------------------------------------------------------------------
// Content banks — a game studio in the OL-183 sense.
// ---------------------------------------------------------------------------

interface ProjectBank {
  title: string;
  /** Position in the production flow; cross-line deps point down-flow. */
  flow: 0 | 1 | 2 | 3;
  lines: string[];
  subs: string[];
  tasks: string[];
}

const PROJECT_BANKS: ProjectBank[] = [
  {
    title: "Tooling",
    flow: 0,
    lines: ["Build pipeline", "Asset importer", "Editor tooling", "CI automation", "Release tooling", "Perforce bridge"],
    subs: ["Pipeline stage", "Importer module", "Editor plugin", "Automation job", "Packaging step", "Integration adapter"],
    tasks: ["compile shader cache", "validate asset manifest", "snapshot editor layout", "retry flaky job", "package build artifacts", "sync workspace mapping", "audit import queue", "warm dependency cache", "gate unstable revision", "archive stale branches"],
  },
  {
    title: "Art",
    flow: 1,
    lines: ["Character art", "Environment art", "VFX library", "Animation set", "UI art", "Concept board"],
    subs: ["Concept batch", "Production pass", "Rigging set", "Texture set", "Polish pass", "Export batch"],
    tasks: ["sculpt high-poly mesh", "retopologize model", "paint texture set", "bind skeleton rig", "author blend shapes", "tune material graph", "bake ambient occlusion", "review silhouette pass", "export LOD chain", "fix texel density"],
  },
  {
    title: "Server",
    flow: 1,
    lines: ["Matchmaking service", "Inventory service", "Progression service", "Social service", "Shop service", "Telemetry pipeline"],
    subs: ["API surface", "Persistence layer", "Replication logic", "Deployment unit", "Load test suite", "Failover path"],
    tasks: ["design request schema", "implement handler", "write storage migration", "add cache invalidation", "wire retry policy", "shadow traffic replay", "load test endpoint", "harden rate limit", "document error codes", "rotate service credentials"],
  },
  {
    title: "Audio",
    flow: 1,
    lines: ["SFX banks", "Ambient beds", "Voiceover pass", "Music stems", "Mix bus", "Dialogue system"],
    subs: ["Recording batch", "Editing pass", "Mix session", "Integration hook", "Localization batch", "QA pass"],
    tasks: ["record source takes", "edit and trim clips", "design layered impact", "mix bus balance", "hook audio trigger", "subtitle timing pass", "compress bank build", "localize dialogue takes", "ducking curve pass", "audit clipping peaks"],
  },
  {
    title: "Client",
    flow: 2,
    lines: ["Input system", "Renderer frame", "UI screens", "Netcode client", "Gameplay framework", "Settings & accessibility"],
    subs: ["Module wiring", "Render path", "Screen flow", "Replication client", "Framework layer", "Options panel"],
    tasks: ["map gamepad bindings", "reduce draw calls", "implement screen transition", "predict remote movement", "reconcile snapshot delta", "pool widget instances", "fix shader permutation", "profile frame spike", "localize string table", "support remapping presets"],
  },
  {
    title: "Level",
    flow: 3,
    lines: ["Onboarding level", "Combat arena", "Hub world", "Story mission set", "Endgame dungeon", "Tutorial sandbox"],
    subs: ["Blockout pass", "Scripting set", "Encounter tuning", "Lighting pass", "Navigation setup", "Playtest loop"],
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

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface LineContext {
  projectId: string;
  projectIndex: number;
  /** All nodes of the line in creation (= topological) order, root first. */
  members: SyntheticGraphNode[];
  root: SyntheticGraphNode;
  /** Leaf task nodes in topological order. */
  leaves: SyntheticGraphNode[];
  fullyDone: boolean;
}

interface Builder {
  rng: Rng;
  config: IssueGraphFixtureConfig;
  nodes: SyntheticGraphNode[];
  edges: SyntheticGraphEdge[];
  projects: { id: string; title: string }[];
  lines: LineContext[];
  identifier: number;
  edgePairs: Set<string>;
}

const unfinishedStatus = (status: string) =>
  status !== "done" && status !== "cancelled";

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

/** Split `total` into `parts` integers, each within [min, max]. */
function partition(rng: Rng, total: number, parts: number, min: number, max: number): number[] {
  const size = Math.min(Math.max(parts, Math.ceil(total / max)), Math.floor(total / min));
  const sizes = Array.from({ length: size }, () => Math.floor(total / size));
  let remainder = total - sizes.reduce((a, b) => a + b, 0);
  let i = 0;
  while (remainder > 0) {
    const at = i % size;
    if (sizes[at]! < max) { sizes[at]! += 1; remainder -= 1; }
    i += 1;
  }
  // Deterministic jitter inside the bounds, keeping the sum fixed.
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

/** Build one task line of exactly `size` nodes (root + sub-lines + leaf tasks). */
function buildLine(builder: Builder, size: number, projectId: string, title: string): LineContext {
  const rng = builder.rng;
  const root = makeNode(builder, null, projectId, title);
  const members = [root];
  const leaves: SyntheticGraphNode[] = [];
  const taskBank = PROJECT_BANKS.find(
    (p) => p.title === builder.projects.find((pr) => pr.id === projectId)!.title,
  )!;
  const leafTitle = () => `${rng.pick(taskBank.tasks)} (${builder.identifier})`;
  const containerTitle = () => `${rng.pick(["Design", "Implement", "Validate", "Integrate", "Polish", "Ship", "Phase A", "Phase B", "Track 1", "Track 2"])} ${title.toLowerCase()}`;
  // Containers come out of the line's own budget so the node total is exact.
  // Depth 4 lines (root → sub → subsub → task) use ~1/3 containers; depth 3
  // lines (root → sub → task) ~1/6, matching "2–3 sub-line layers".
  const budget = size - 1;
  const deep = budget >= 24 && rng.chance(0.5);
  const leafCount = deep
    ? Math.max(2, Math.round(budget * 2 / 3))
    : Math.max(2, Math.round(budget * 5 / 6));
  if (!deep) {
    // Depth 3: sub-lines hold leaf tasks directly. Group count = remaining
    // container budget; partition keeps every group within [3, 14].
    const subCount = Math.max(2, Math.min(8, budget - leafCount));
    const groups = partitionEven(rng, leafCount, subCount, 3, 14);
    for (const group of groups) {
      const sub = makeNode(builder, root.id, projectId, containerTitle());
      members.push(sub);
      for (let i = 0; i < group; i++) leaves.push(makeNode(builder, sub.id, projectId, leafTitle()));
    }
  } else {
    // Depth 4: sub-lines hold subsub containers, which hold leaf tasks.
    const containerCount = budget - leafCount;
    const subCount = Math.max(2, Math.min(4, Math.floor(containerCount / 3)));
    const subsubTotal = containerCount - subCount;
    const subs = Array.from({ length: subCount }, () => 0);
    // Spread subsubs over subs, then leaves over subsubs, deterministically.
    let subsubCursor = 0;
    const subsubOfSub: number[][] = Array.from({ length: subCount }, () => []);
    while (subsubCursor < subsubTotal) {
      const at = subsubCursor % subCount;
      subsubOfSub[at]!.push(subsubCursor);
      subs[at]! += 1;
      subsubCursor += 1;
    }
    const leavesPerSubsub = partitionEven(
      rng,
      leafCount,
      Math.max(1, subsubTotal),
      2, 10,
    );
    let leafCursor = 0;
    for (const [subIndex, subsubs] of subsubOfSub.entries()) {
      const sub = makeNode(builder, root.id, projectId, containerTitle());
      members.push(sub);
      const count = Math.max(1, subs[subIndex]!);
      void count;
      for (const subsubIndex of subsubs) {
        const subsub = makeNode(builder, sub.id, projectId, `${sub.title} — ${rng.pick(["setup", "build", "verify", "harden", "release"])}`);
        members.push(subsub);
        const take = leavesPerSubsub[subsubIndex] ?? 2;
        for (let i = 0; i < take && leafCursor < leafCount; i++) {
          leaves.push(makeNode(builder, subsub.id, projectId, leafTitle()));
          leafCursor += 1;
        }
      }
    }
    // Any leaf budget the spread missed lands in the last subsub.
    while (leafCursor < leafCount) {
      const parent = leaves.at(-1)?.parent_issue_id ?? root.id;
      leaves.push(makeNode(builder, parent, projectId, leafTitle()));
      leafCursor += 1;
    }
  }
  for (const leaf of leaves) members.push(leaf);
  // Stages follow the topological order of the line's tasks (1–6).
  leaves.forEach((leaf, index) => {
    leaf.stage = Math.min(6, 1 + Math.floor((index / leaves.length) * 6));
  });
  return { projectId, projectIndex: 0, members, root, leaves, fullyDone: false };
}

/** Split `total` into exactly `parts` integers in [min, max] (deterministic;
 * the caller guarantees feasibility: parts*min <= total <= parts*max). */
function partitionEven(rng: Rng, total: number, parts: number, min: number, max: number): number[] {
  const size = Math.min(Math.max(parts, Math.ceil(total / max)), Math.floor(total / min));
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

/** Assign statuses along a line's task sequence: done prefix, active frontier, open tail. */
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
  // A line without an active run yet still needs at least one in-progress task.
  if (!leaves.some((leaf) => leaf.status === "in_progress")) {
    const at = Math.min(donePrefix, leaves.length - 1);
    if (at >= 0) leaves[at]!.status = "in_progress";
  }
}

/** Container/root status derives from descendants, like the real projection. */
function deriveContainerStatuses(line: LineContext): void {
  const byParent = new Map<string | null, SyntheticGraphNode[]>();
  for (const node of line.members) {
    const list = byParent.get(node.parent_issue_id) ?? [];
    list.push(node);
    byParent.set(node.parent_issue_id, list);
  }
  const resolve = (node: SyntheticGraphNode): string => {
    if (!byParent.has(node.id)) return node.status;
    const childStatuses = (byParent.get(node.id) ?? []).map(resolve);
    if (childStatuses.every((status) => status === "done")) return "done";
    if (childStatuses.includes("in_progress")) return "in_progress";
    if (childStatuses.includes("in_review")) return "in_review";
    if (childStatuses.includes("blocked")) return "blocked";
    return "todo";
  };
  for (const node of line.members) {
    if (byParent.has(node.id)) node.status = resolve(node);
  }
}

/** In-line prerequisites: every leaf task gets 1–2, earlier in the line. */
function addInLineDependencies(builder: Builder, line: LineContext): void {
  const rng = builder.rng;
  line.leaves.forEach((leaf, index) => {
    const candidates: SyntheticGraphNode[] = [];
    if (index === 0) {
      candidates.push(line.root);
    } else {
      candidates.push(line.leaves[index - 1]!);
      const second = rng.pick([line.root, line.leaves[Math.max(0, index - 2)]!, line.leaves[Math.max(0, index - 3)]!]);
      if (second !== candidates[0]) candidates.push(second);
      if (rng.chance(0.5)) candidates.length = 1;
    }
    for (const prereq of candidates) addEdge(builder, prereq.id, leaf.id);
  });
}

export function buildIssueGraphFixture(
  dataset: IssueGraphFixtureDatasetName | IssueGraphFixtureConfig,
): SyntheticIssueGraph {
  const config = typeof dataset === "string" ? ISSUE_GRAPH_FIXTURE_DATASETS[dataset] : dataset;
  const rng = new Rng(config.seed);
  const builder: Builder = {
    rng,
    config,
    nodes: [],
    edges: [],
    projects: PROJECT_BANKS.map((bank) => ({ id: rng.uuid(), title: bank.title })),
    lines: [],
    identifier: 0,
    edgePairs: new Set(),
  };

  // Lines are created down the production flow so every cross-line edge can
  // only point from an earlier line to a later one: no cycles by construction.
  const lineCount = config.singleLine ? 1 : Math.max(6, Math.round(config.totalTasks / 35));
  const lineSizes = config.singleLine
    ? [config.totalTasks]
    : partition(rng, config.totalTasks, lineCount, 30, 40);
  // Spread lines across the six projects, flow group by flow group.
  const flowOrder: number[] = [];
  const flows = [0, 1, 1, 1, 2, 3];
  for (const flow of [0, 1, 2, 3]) {
    for (const projectIndex of PROJECT_BANKS.map((_, i) => i).filter((i) => flows[i] === flow)) {
      flowOrder.push(projectIndex);
    }
  }
  let built = 0;
  const projectCursor = new Array(PROJECT_BANKS.length).fill(0);
  while (built < lineSizes.length) {
    for (const projectIndex of flowOrder) {
      if (built >= lineSizes.length) break;
      const bank = PROJECT_BANKS[projectIndex]!;
      const projectId = builder.projects[projectIndex]!.id;
      const name = bank.lines[projectCursor[projectIndex]! % bank.lines.length]!
        + (projectCursor[projectIndex]! >= bank.lines.length
          ? ` ${Math.floor(projectCursor[projectIndex]! / bank.lines.length) + 1}`
          : "");
      projectCursor[projectIndex]! += 1;
      const line = buildLine(builder, lineSizes[built]!, projectId, name);
      line.projectIndex = projectIndex;
      builder.lines.push(line);
      built += 1;
    }
  }

  // Which lines are fully completed (hidden by default). The first line —
  // always a tooling line, upstream of everything — is forced done so the
  // cancelled-but-still-blocking case below has a guaranteed home.
  const { profile } = config;
  builder.lines.forEach((line, index) => {
    line.fullyDone = !config.singleLine && (index === 0 || rng.chance(profile.doneLineShare));
  });
  for (const line of builder.lines) {
    if (line.fullyDone) {
      for (const member of line.members) member.status = "done";
    } else {
      applyFrontier(builder, line);
    }
    deriveContainerStatuses(line);
  }

  // The cancelled-but-still-blocking case: a cancelled task inside a hidden
  // fully-done line, with a direct dependent in a visible unfinished line.
  if (!config.singleLine) {
    const anchor = builder.lines[0]!;
    const cancelledLeaf = anchor.leaves[Math.min(2, anchor.leaves.length - 1)]!;
    cancelledLeaf.status = "cancelled";
    const downstream = builder.lines.find(
      (line) => !line.fullyDone && PROJECT_BANKS[line.projectIndex]!.flow >= 2,
    ) ?? builder.lines.find((line) => !line.fullyDone)!;
    const target = downstream.leaves.find((leaf) => unfinishedStatus(leaf.status)) ?? downstream.leaves.at(-1)!;
    addEdge(builder, cancelledLeaf.id, target.id);
  }

  // Dependencies. Cross-line sources come from strictly earlier lines, which
  // the creation order keeps acyclic.
  builder.lines.forEach((line, lineIndex) => {
    addInLineDependencies(builder, line);
    if (lineIndex === 0 && !config.singleLine) return; // no earlier line exists
    const pool = builder.lines.slice(0, lineIndex);
    if (!pool.length) return;
    for (const leaf of line.leaves) {
      if (!rng.chance(profile.crossLineShare)) continue;
      const sourceLine = rng.pick(pool);
      const source = rng.pick(sourceLine.leaves);
      addEdge(builder, source.id, leaf.id);
    }
    if (!config.singleLine && line.root !== builder.lines[0]!.root && rng.chance(profile.crossLineShare)) {
      // Line-level dependency: one line waiting on another line's output.
      const sourceLine = rng.pick(pool);
      addEdge(builder, sourceLine.leaves[Math.floor(sourceLine.leaves.length / 2)]!.id, line.root.id);
    }
  });

  // Post-pass: run summaries for active work, dependency summaries, assignees.
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
    } else if (node.status === "in_review" || node.status === "blocked") {
      node.assignee = rng.chance(0.5) ? { id: rng.pick(MEMBER_IDS), type: "member" } : null;
    } else if (node.status === "todo" || node.status === "backlog") {
      node.assignee = rng.chance(0.25) ? { id: rng.pick(MEMBER_IDS), type: "member" } : null;
    }
  }
  const prereqsOf = new Map<string, string[]>();
  for (const edge of builder.edges) {
    const list = prereqsOf.get(edge.target) ?? [];
    list.push(edge.source);
    prereqsOf.set(edge.target, list);
  }
  const byId = new Map(builder.nodes.map((node) => [node.id, node]));
  for (const node of builder.nodes) {
    const prereqs = (prereqsOf.get(node.id) ?? []).map((id) => byId.get(id)!);
    // The server only treats `done` as satisfied: cancelled prerequisites keep
    // blocking — that is the case the DAG redo draws in red.
    const unsatisfied = prereqs.filter((prereq) => prereq.status !== "done").length;
    node.dependency_summary = {
      visible_unsatisfied_count: unsatisfied,
      has_restricted_blockers: false,
      dependency_version: rng.hex64(),
    };
  }

  return {
    schema_version: 1,
    snapshot_id: rng.hex64(),
    topology_id: rng.hex64(),
    captured_at: CAPTURED_AT,
    complete: true,
    scope: { type: "workspace", project_id: null },
    focus_issue_id: null,
    matched_count: builder.nodes.length,
    context_count: 0,
    nodes: builder.nodes,
    edges: builder.edges,
    projects: builder.projects,
    has_restricted_context: false,
  };
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
  fullyDoneLines: number;
  hiddenLineTasks: number;
  /** Tasks not done and not cancelled — OL-183's "unfinished". */
  unfinished: number;
  statuses: Record<string, number>;
  maxDepth: number;
  minDepth: number;
  stages: { min: number; max: number };
  crossLineTasks: number;
  crossLineShare: number;
  inProgressWithoutRunSummary: number;
  /** Cancelled tasks inside fully-done lines that still block unfinished work. */
  cancelledStillBlocking: number;
  acyclic: boolean;
}

export function analyzeIssueGraphFixture(graph: SyntheticIssueGraph): IssueGraphFixtureStats {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, SyntheticGraphNode[]>();
  for (const node of graph.nodes) {
    const list = children.get(node.parent_issue_id) ?? [];
    list.push(node);
    children.set(node.parent_issue_id, list);
  }
  const roots = children.get(null) ?? [];
  const depthOf = (node: SyntheticGraphNode): number => {
    let depth = 1;
    let current = node;
    while (current.parent_issue_id !== null) {
      current = byId.get(current.parent_issue_id)!;
      depth += 1;
    }
    return depth;
  };
  const lineOf = new Map<SyntheticGraphNode, SyntheticGraphNode>();
  for (const root of roots) {
    const walk = (node: SyntheticGraphNode) => {
      lineOf.set(node, root);
      for (const child of children.get(node.id) ?? []) walk(child);
    };
    walk(root);
  }
  const statuses: Record<string, number> = {};
  for (const node of graph.nodes) statuses[node.status] = (statuses[node.status] ?? 0) + 1;
  const leaves = graph.nodes.filter((node) => !children.has(node.id));
  const lineMembers = (root: SyntheticGraphNode) => {
    const members: SyntheticGraphNode[] = [];
    const walk = (node: SyntheticGraphNode) => {
      members.push(node);
      for (const child of children.get(node.id) ?? []) walk(child);
    };
    walk(root);
    return members;
  };
  const finished = (node: SyntheticGraphNode) =>
    node.status === "done" || node.status === "cancelled";
  const fullyDoneRoots = roots.filter((root) => lineMembers(root).every(finished));
  const hiddenLineTasks = fullyDoneRoots.reduce((sum, root) => sum + lineMembers(root).length, 0);
  const downstream = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = downstream.get(edge.source) ?? [];
    list.push(edge.target);
    downstream.set(edge.source, list);
  }
  let cancelledStillBlocking = 0;
  for (const node of graph.nodes) {
    if (node.status !== "cancelled") continue;
    const line = lineOf.get(node)!;
    if (!fullyDoneRoots.includes(line)) continue;
    const blocks = (downstream.get(node.id) ?? []).some((id) => !finished(byId.get(id)!));
    if (blocks) cancelledStillBlocking += 1;
  }
  // Kahn topological check over the directed edge set.
  const indegree = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
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
  const depths = graph.nodes.map(depthOf);
  const stages = leaves.map((leaf) => leaf.stage ?? 0).filter((stage) => stage > 0);
  const crossLineTasks = graph.nodes.filter((node) =>
    (downstream.get(node.id) ?? []).length > 0
    && (downstream.get(node.id) ?? []).some((target) => lineOf.get(byId.get(target)!) !== lineOf.get(node)!),
  ).length;
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    leaves: leaves.length,
    containers: graph.nodes.length - leaves.length,
    lines: roots.length,
    fullyDoneLines: fullyDoneRoots.length,
    hiddenLineTasks,
    unfinished: graph.nodes.filter((node) => unfinishedStatus(node.status)).length,
    statuses,
    maxDepth: Math.max(...depths),
    minDepth: Math.min(...depths),
    stages: { min: Math.min(...stages), max: Math.max(...stages) },
    crossLineTasks,
    crossLineShare: leaves.length ? crossLineTasks / leaves.length : 0,
    inProgressWithoutRunSummary: graph.nodes.filter(
      (node) => node.status === "in_progress" && node.run_summary == null,
    ).length,
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
