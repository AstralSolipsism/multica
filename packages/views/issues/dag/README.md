# DAG scene layout (Stage 8)

The existing `useDagLayout` / `layoutDagProjection` canvas stays available until
Stage 9. New consumers use the independent scene API below. It imports only
the core models; it does not fetch data or choose rendering styles.

```ts
const plan = dagOverviewLayoutInput(overview);
// Or dagLineLayoutInput(line), dagFocusLayoutInput(focus),
// dagIndependentLayoutInput(independentTasks).
const scene = useDagSceneLayout(`${workspaceId}:${queryKey}`, plan, model);
```

Keep this hook mounted when navigating between views. The scope key must
include the workspace and query identity. Changing scope disposes workers and
caches and removes the old scene immediately. Within a scope, the last complete
geometry **and its matching plan/model** stay usable until replacement succeeds.
Title/status updates with unchanged geometric input paint immediately without
dispatching another layout. `pending`, `error`, `cancel()` and `retry()` let
Stage 9 display its controls while the old scene remains interactive.

## Geometry contract

- `input` contains only geometry: ordered model IDs, sizes, frame hierarchy,
  stages, endpoint kinds and dependency topology. It contains no titles,
  status, runs, selected IDs or raw bundle membership. Dimensions and the sole
  left-to-right direction policy are in `dag-constants.ts`.
- `nodes` and `frames` use absolute canvas coordinates. `ports[id]` has exactly
  one `input` on the left and one `output` on the right. Card ports are centered;
  ELK chooses frame port heights. Edge endpoints use `sourceKind` / `targetKind`
  from the model. Cross-hierarchy edges use `INCLUDE_CHILDREN` with orthogonal
  routing and `NETWORK_SIMPLEX` node placement.
- `routes[edgeId]` is an ordered orthogonal polyline. `segments` partitions these
  paths at shared trunks; each segment contains the scene `edgeIds` traversing
  it. `junctions` gives branch/merge dots. Unrelated parallel paths remain
  distinct, including coincident paths connected by a third edge's endpoints.
  Render segments once and use current model states for their style.
- Resolve segment `edgeIds` through the **current** plan's `dependencyIds` to
  select original dependencies. A mixed overview bundle includes satisfied and
  unsatisfied originals. Deduplicate raw IDs when selecting several segments.
  Do not cache status or original membership in the geometry.
- Stage bands are relative horizontal intervals within a frame, sorted by
  stage. Only leaf frames with fully staged, dependency-compatible membership
  get columns. A container with nested frames, incomplete stages or a stage
  cycle uses `stageMode: "labels"`. Leaf sub-lines support columns inside
  `INCLUDE_CHILDREN`; invisible ordering boundaries also place disconnected
  later-stage tasks in their proper columns (nested partitions alone do not).
  These constraints never appear as visible dependencies. If cross-hierarchy placement
  does not separate the requested stages, it also yields to labels.
- A focus line spanning both sides of the selected task is represented by
  separate upstream/current/downstream frame fragments. `frame.modelId` retains
  the logical issue identity for headings and navigation. Invisible side scopes
  enforce upstream-left/current-center/downstream-right, including nested lines.
  Context-only frames are never turned into task cards.

## Scheduling, caches and overlays

`createDagSceneRunner()` owns one worker channel for each of overview, line and
focus. A newer request supersedes only its own class; identical in-flight input
reuses that work. Each class has a 24-entry content LRU, so opened lines cache
independently. Keys serialize explicit geometric fields, with no hash collisions
or dependence on object property insertion order. Scope disposal clears all
entries. Treat returned geometry as immutable.

After an overview completes, line/focus workers preload ELK. Each worker uses
ELK's supported child-worker API. A 3,000 ms main-thread deadline terminates the
over-budget worker (a Promise race alone cannot stop ELK), then requests bounded
group packing in a replacement worker. `quality: "fallback"` identifies this
result; stage columns become labels. Packing preserves membership and orthogonal
endpoint routes but sacrifices ELK's crossing/obstacle optimization. Grid scenes
report `quality: "grid"`; regular results report `"elk"`.

Fully satisfied overview dependencies are **always overlays**, even when the
show-satisfied switch is on. That switch does not enter the placement key.
`routeDagOverlays(geometry, plan.overlays, plan.input.edges)` returns combined
base/overlay routes, segments and dots without
changing boxes; it uses simple orthogonal corridors. Hover uses
`dagOverviewHoverEdges(model, cardId)` and the same router. Mixed bundles reuse
their existing route while `overlayDependencyIds` / hover membership select
only the satisfied subset. The optional third argument composes trunk
membership across base and overlay edges before styling or hit testing; use
the returned segments as the complete displayed set. Omitting it returns just
the overlay geometry for a separate highlight layer.

ELK uses deterministic seed 1, low thoroughness and bottom-up crossing sweeps.
Only overview uses model-order preference. Enabling `NODES_AND_EDGES` order on
nested graphs with disconnected members can crash ELK 0.12; line/focus do not
force model order. The regression test combines reversed stage dependencies
with a disconnected member.

## Verification and artifacts

```sh
pnpm --filter @multica/views exec vitest run issues/dag
node scripts/benchmark-dag-layout.mjs --fixture accept-5000.json --big-line big-line.json --compare-all-edges --output results
node scripts/benchmark-dag-layout.mjs --snapshot graph.json --lines OL-71,OL-110,OL-155 --focus OL-177 --output real-lines
```

Use the shared OL-278 generator for fixture JSONs. The benchmark bundles the
production worker path and serves only local static assets to headless Chromium;
no app/backend is started or changed. It records cold entry, five warmups, then
10 uncached measurements (override `--samples`), plus an actual content-cache
hit. Changing only the scene ID forces a miss without changing graph geometry.
Top-level timings include worker transfer and result collection; `compute`
separately measures worker geometry work after ELK loads. The heartbeat reports
main-thread delay while workers run. The optional `--compare-all-edges`
overview trial measures tuned ELK under the same 3s deadline, for comparison
with the overlay policy. Do not run other local checks during measurements.

The script writes `report.json`, full `*.geometry.json` and standalone SVGs.
SVGs are geometry inspection artifacts, not Stage 9 UI mockups. `--snapshot`
accepts an authorized schema-v1 graph rendering fixture; when reconstructing
selected complete task lines through CLI reads, record that limited provenance
beside the file rather than describing it as a full-workspace API capture.
Real snapshots may contain private workspace data: keep them out of Git and
deliver only the requested rendered lines through issue attachments.
