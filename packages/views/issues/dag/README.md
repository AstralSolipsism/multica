# DAG scene layout (Stage 8)

The overview, line and focus DAG canvas (Stages 9–10) renders exclusively through the scene API
below: `dag-view.tsx` builds plans from the OL-279 models, this engine computes
geometry, and `dag-scene-canvas.tsx` paints it. The engine imports only the
core models; it does not fetch data or choose rendering styles.

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
  status, runs, selected IDs or raw bundle membership. Dimensions, ELK direction
  and port sides are in `dag-constants.ts`. Only left-to-right is supported:
  frame/serial restoration, stage bands, grids, fallback and overlay routing
  also use horizontal geometry. Changing `DAG_FLOW` alone does not implement
  another orientation.
- `nodes` and `frames` use absolute canvas coordinates. `ports[id]` has exactly
  one `input` on the left and one `output` on the right. Card ports are centered;
  ELK chooses frame port heights. Edge endpoints use `sourceKind` / `targetKind`
  from the model. Cross-hierarchy edges use `INCLUDE_CHILDREN` with orthogonal
  routing and `NETWORK_SIMPLEX` node placement.
  A frame containing only another frame and having no own dependency endpoint
  contributes padding to the same ELK compound node; both frame outlines and
  logical ports are restored in the geometry. This avoids solving a redundant
  hierarchy level without removing any public frame. Frames with explicit
  dependency endpoints retain their own ELK node.
  ELK receives compact, request-local IDs to reduce repeated string hashing
  and worker copies; every returned geometry ID is restored to the input ID.
  Serial runs within one line frame and stage reserve their full width as one
  ELK node. Every card, port and internal edge is restored afterwards. This
  only folds links with one outgoing edge at the source and one incoming edge
  at the target, matching height/side and no frame/stage boundary. Branches and
  merges still participate in ELK; a run's reserved rectangle keeps unrelated
  routes out of its internal card gaps. Cycles are never folded.
- `routes[edgeId]` is an ordered orthogonal polyline, preserving direction for
  arrows and animations. Under the owner's OL-280 option B decision, every
  collinear overlapping interval is rendered once as a bus, even when the
  traversing edges have different endpoints or directions. `segments` splits
  at route boundaries and contains the exact sorted union of scene `edgeIds`
  occupying each interval. Segment coordinates run from low to high; they do
  not encode dependency direction. `junctions` gives three-or-more-direction
  branch/merge dots with their incident edge IDs. Shared corners and unrelated
  perpendicular crossings are not junctions. Render segments once and resolve
  their complete membership before choosing a status style, so an overlay
  cannot paint over a blocking dependency on the same interval.
- Resolve segment `edgeIds` through the **current** plan's `dependencyIds` to
  select original dependencies. A mixed overview bundle includes satisfied and
  unsatisfied originals. Deduplicate raw IDs when selecting several segments.
  Do not cache status or original membership in the geometry.
- Node selection/highlighting must start from real model dependencies, then
  draw each selected dependency's complete ordered `routes`, dimming the rest.
  Only the intervals those dependencies actually traverse should light up; an
  unselected branch joining the same bus stays dim. Never traverse
  geometric bus connectivity or expand a selected edge to every bus passenger.
  For A→X, A→Y and B→Y, selecting Y highlights A→Y/B→Y, selecting X highlights
  only A→X, and selecting B highlights only B→Y. Task-line expansion likewise
  uses the model's actual dependencies. Clicking a bus itself can select all
  its original dependency IDs. Stage 9/10 own this interaction, status priority
  and effects; the unselected overview intentionally does not disambiguate
  every source/target pairing by shape alone. The geometry tests cover this
  example and check canonical bus membership on actual shared-fixture ELK output.
- Stage bands are relative horizontal intervals within a frame, sorted by
  stage. Only leaf frames with fully staged, dependency-compatible membership
  get columns. A container with nested frames, incomplete stages or a stage
  cycle uses `stageMode: "labels"`. Leaf sub-lines support columns inside
  `INCLUDE_CHILDREN`; invisible ordering boundaries also place disconnected
  later-stage tasks in their proper columns (nested partitions alone do not).
  These constraints never appear as visible dependencies. If existing paths
  already order every earlier-stage member before every next-stage member,
  redundant ordering boundaries are omitted. If cross-hierarchy placement
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

While the overview runs, the line worker preloads ELK; focus preloads when the
overview or a directly restored line completes, avoiding three simultaneous initializations. Each worker uses
ELK's supported child-worker API. A 3,000 ms main-thread deadline terminates the
over-budget worker (a Promise race alone cannot stop ELK), then requests bounded
group packing in a replacement worker. `quality: "fallback"` identifies this
result; stage columns become labels. Packing preserves membership and orthogonal
endpoint routes but sacrifices ELK's crossing/obstacle optimization. Grid scenes
report `quality: "grid"`; regular results report `"elk"`.

Preloading registers only the layered algorithm and runs a small compound
graph, so it initializes the simplex and routing phases as well as loading the
module. An empty graph does not exercise those phases. Named worker channels
let the flat overview skip this unnecessary compound warmup on the initial
screen; line/focus warm those phases on their own channels.

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
Lines use longest-path horizontal ranks and keep `NETWORK_SIMPLEX` placement
within ranks. Optional straight-edge alignment is disabled; routes remain
orthogonal. These settings avoid extra work without fixing rows by status.
Only overview uses model-order preference. Enabling `NODES_AND_EDGES` order on
nested graphs with disconnected members can crash ELK 0.12; line/focus do not
force model order. The regression test combines reversed stage dependencies
with a disconnected member.

Overview has no frames and uses normal component packing (`SEPARATE_CHILDREN`).
Its component ordering also respects model order, so isolated cards do not
automatically precede every connected component.
Line/focus use `INCLUDE_CHILDREN`. Applying compound processing to the flat
overview would stack disconnected line cards in a single tall column.

## Verification and artifacts

```sh
pnpm --filter @multica/views exec vitest run issues/dag
node scripts/benchmark-dag-layout.mjs --compare-all-edges --output results
node scripts/benchmark-dag-layout.mjs --snapshot graph.json --lines OL-71,OL-110,OL-155 --focus OL-177 --output real-lines
```

Defaults build `accept-5000` and `big-line` using the shared OL-278 generator
and record its version, digests and shape statistics. Optional `--fixture`
and `--big-line` flags accept explicit schema-v1 JSONs. The benchmark bundles the
production worker path and serves only local static assets to headless Chromium;
no app/backend is started or changed. It records cold entry, five warmups, then
10 uncached measurements (override `--samples`; acceptance uses 30), plus an actual content-cache
hit. The first line opens immediately after the first overview completes,
before any benchmark warmups. Changing only the scene ID forces a miss without changing graph geometry.
Top-level timings include worker transfer and result collection; `compute`
separately measures worker geometry work after ELK loads, and `elk` isolates
the engine call. Reports retain individual samples. The heartbeat reports
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

## Focus navigation (Stage 10)

The selection zone's **Focus mode** action traces a raw issue across task lines
using `computeDagFocus`. Upstream/downstream highlight actions keep their
in-place behavior. The focus scene uses the same cards, frame headers, buses,
selection resolver and per-dependency highlight routes as the line scene;
satisfied and redundant dependencies are always present. Frame fragments keep
scene IDs for selection/geometry and raw issue IDs for issue actions. Cyclic
peers sit in the current column. Retained cancelled context ancestors inherit
the side of their focused descendants instead of defaulting to downstream.

`dagFocusIssueId` overlays the remembered `dagLineId` and overview pin. These
level pointers and `focus:<issueId>` viewports persist per user, outside saved
view definitions. Entry snapshots the live painted viewport; the close button
and parent breadcrumb restore the entry level. The overview breadcrumb can
return directly to the overview. Focus requests are gated by the painted
`overview` / `line` / `focus` kind, including requests for fragmented frames.

Q11 counts hidden closure members once and never forces them onto the canvas.
The count and Show completed action remain visible even with no selection.
A hidden seed stays in focus with an explicit hint; a deleted/filtered-out seed
returns to the entry level with a notice. A restored line that also disappeared
then follows the normal overview fallback.

`e2e/dag-focus.spec.ts` covers entry, cross-line content, Q11, reload and viewport
restoration against the production frontend with controlled API responses.
Its optional `DAG_SNAPSHOT_PATH` / `DAG_FOCUS_IDENTIFIER` case renders an
authorized CLI-reconstructed schema-v1 graph for review screenshots; raw
workspace fixtures stay outside Git. The Stage 7 browser performance scenario
now measures a typical closure and the dataset's largest closure,
including click-to-render time and the largest animation-frame interval.
