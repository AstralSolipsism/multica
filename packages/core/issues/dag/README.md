# DAG data and models

This is the headless boundary for the DAG (OL-279). It contains no React Flow
types, layout, geometry or UI. The overview, line and focus canvases read
exclusively through these models; their React Flow adapters stay in views.
`projection.ts` now holds only the shared display forest, completed visibility
and independent-task helpers; the retired folding projection is removed.

## Consumers

```ts
import { useDagModels } from "@multica/core/issues/dag";

const result = useDagModels(wsId, querySpec, {
  view: "overview", showCompleted: false, showSatisfiedDependencies: false,
});
// Other requests:
// { view: "line", lineId } (top-level issue ID, not a canvas representative)
// { view: "focus", issueId, showCompleted: false }
// result.models is null until data is available. Query errors are preserved.
```

The three pure builders take a shared `createDagModelIndex(graph)`:
`computeDagOverview`, `computeDagLine`, and `computeDagFocus`. The hook's selector
creates the index once per snapshot and only builds the requested model.

- Overview IDs preserve existing representatives (`issue:<root>` and
  `independent:root`); raw dependency IDs are always retained. A mixed bundle
  contains **all** its originals, including satisfied ones. The default filter
  removes only fully satisfied bundles. `satisfiedByCard` also contains the
  satisfied subset of mixed bundles, for hover overlays.
- Line and focus endpoints use raw issue IDs. `sourceKind` / `targetKind` say
  whether to attach to a frame. `frames` have immediate `taskIds` / `frameIds`
  and repaired `parentId`; parent issues are frame headers, not duplicate tasks.
  Line members are never filtered by the completed switch. External dependencies
  are grouped by the other endpoint's top-level line (or standalone issue),
  separately for upstream and downstream; the group's project is its root's.
- Progress excludes a line's root and counts only the `done` category.
  Unfinished status counters,
  runs, attention and match/context include the root. Unknown categories remain
  unfinished and have a separate count; missing summaries remain unknown.
- Overview attention is exception, advancing, review, unstarted, finished;
  priority and numeric identifier descending break ties. This is a layout
  preference only. An active run advances a review/blocked source dependency;
  a cancelled source remains cancelled-blocking regardless of runs.
- A parent dependency target is finished only after the entire subtree ends.
  Q3 hides only complete top-level lines. Q4 pulls cancelled blockers out of
  hidden lines as standalone context cards, including prerequisites inherited
  through an already-finished parent with unfinished children.
- Redundancy includes inherited prerequisites but never treats parent status
  as a child wait. An unsatisfied redundant edge is retained if every alternate
  path crosses a finished intermediate waiter. Inheritance through a finished
  parent still conveys a wait to its children, but that parent's own outgoing
  dependencies cannot convey it. Focus exposes redundant edges without hiding
  them. Inconsistent dependency cycles conservatively keep all edges.
- Focus takes a raw issue ID as a single task seed and uses the same raw
  upstream/downstream traversal, including inherited prerequisites.
  Visible ancestor frames needed solely for grouping have `contextOnly: true`.
  Hidden closure members are counted once, never reintroduced as frame headers.
- Restricted context is a boolean, not a synthesized node or hidden count.
  Match/context labels are preserved; missing parents and parent cycles are
  repaired only for display. Source graphs are not mutated.

## Object identity

Pass the previous index to `createDagModelIndex(graph, previous)` and the
previous line to `computeDagLine(index, lineId, previousLine)` to reuse an
unchanged line model. `createDagModelSelector` does this for opened lines and
also reuses overview cards, evicting removed/changed lines. It includes external
endpoint states, root metadata and project labels in equality comparisons.
It must be scoped to one workspace/query; `useDagModels` resets it on that key.

`DagIssue` omits only the run summary's `capturedAt`. Snapshot freshness remains
on the Query result; refreshing timestamps alone must not invalidate every
line's layout. Models and their arrays/maps are immutable consumer inputs.

## Changing the transport

Views must use `useDagGraph` / `useDagModels` / `useDagSurfaceGraph`, not
`issueGraphOptions`. The full-graph endpoint remains in use until OL-275
establishes a need to replace it.

For a future per-line endpoint, change `use-dag-data.ts` (query orchestration)
and `selector.ts` / `model-index.ts` (assemble the authorized inputs required
by the active view). Add its API method/schema and query keys in core alongside
`api/issue-graph-schemas.ts` and `issues/graph.ts`; preserve aborts, workspace
isolation, realtime invalidation and full validation. The pure overview/detail
output contracts and views' imports need not change. Never make a partial read
pretend to be a complete `IssueGraph`.

## Validation and measurement

```sh
pnpm --filter @multica/core exec vitest run issues/dag api/issue-graph-schemas.test.ts
pnpm --filter @multica/views exec vitest run issues/dag issues/surface/use-issue-surface-controller.test.tsx
node scripts/benchmark-dag-models.mjs --output /path/to/report.json
# Optionally substitute explicit fixture JSONs:
node scripts/benchmark-dag-models.mjs --fixture-5000 /path/to/accept-5000.json --fixture-10000 /path/to/10000.json
# Read-only inspection of an authorized schema-v1 snapshot:
node scripts/benchmark-dag-models.mjs --inspect /path/to/graph.json
```

The runner bundles the actual model code in production mode and runs
synchronously in Chromium's main thread, with no workers or application server.
Install Chromium with `pnpm exec playwright install chromium` when needed.
It reports the first call, then p50/p95/max over 30 samples after five warmups,
with CPU, RAM, OS and browser version. Run without concurrent checks. Overview
includes index construction; line/focus reuse the index already held by the
view. Both completed toggles are also measured. Parsing includes JSON.parse
and the unchanged `IssueGraphSchema` with its complete integrity checks.

Defaults use the shared OL-278 generator in
`issues/testing/issue-graph-fixture.ts`: `accept-5000` and `10000`. Its version
appears in the report. The temporary OL-279 generator has been removed, so model
and layout measurements use the same maintained datasets.
