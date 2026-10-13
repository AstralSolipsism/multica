# UI performance scenarios

Two browser scenarios, both run against the real Next.js production build
with fully synthetic HTTP and WebSocket — no API server, database, daemon,
agent or account involved. Nothing disables animations or trims the DOM: the
cost being measured lives in that machinery.

1. **Comment typing under live agent runs** (`typing-under-live-runs.spec.ts`)
   — exists because of MUL-7227, where a summary animation replaced a DOM
   node per streamed message and typing a comment slowed to a crawl.
   Component tests could not see it — they run in jsdom, which has no style
   recalculation, no layout and no main-thread contention.
2. **DAG view** (`dag-view.spec.ts`, OL-278) — measures the issues page's
   dependency-graph view against synthetic graph datasets (OL-183's shapes):
   fetch, parse+validate, layout, first-interactive, pan/zoom frame rate and
   card-click response.

It covers the renderer shared by Web and Desktop. Electron's own
main-process behaviour is not exercised here.

## Running it

Against a frontend you already have running:

```bash
# typing scenario only (what the comparison measures)
pnpm exec playwright test --config=playwright.perf.config.ts e2e/perf/typing-under-live-runs.spec.ts
# PLAYWRIGHT_BASE_URL defaults to http://localhost:3000
# PERF_REPORT_PATH=<file> also writes the JSON report
```

Running only the DAG scenario, with a dataset and optional 4× CPU throttle:

```bash
PERF_DATASET=stress-5000 PERF_THROTTLE_CPU=4 PERF_REPORT_PATH=dag-report.json \
  pnpm exec playwright test --config=playwright.perf.config.ts e2e/perf/dag-view.spec.ts
```

`PERF_DATASET` picks one of the synthetic graphs (see below); unset or `none`,
the DAG scenario is skipped — a bare perf run measures the typing scenario
only, and `perf-compare.mjs` pins itself to the typing spec for the same
reason. `PERF_THROTTLE_CPU` (default 1) applies CDP CPU throttling — see the
caveat below. Reports land in `PERF_REPORT_PATH` and on stdout as
`PERF_REPORT {…}`.

Comparing two refs — this builds and measures each one, in sequence:

```bash
node scripts/perf-compare.mjs --base origin/main --head HEAD --out perf-report
```

The comparison needs Node, pnpm and Chromium. It writes `comparison.json` and
`comparison.md`. Each side stops its server, waits for it to exit and removes
its worktree before the next side starts, and the script exits on its own on
success, on failure and on cancellation.

The ordinary e2e suite ignores this directory; it needs a production build and
a machine that is not busy doing anything else.

## DAG datasets

`packages/core/issues/testing/issue-graph-fixture.ts` generates the graphs
deterministically (fixed seeds; byte-identical output per dataset), and
`packages/core/issues/testing/issue-graph-fixture.test.ts` pins the shape:
passes `IssueGraphSchema`, exact node counts, depth ≤ 4, ~20% cross-line
dependencies, OL-183's unfinished budget for `accept-5000` (≤ 800) and
OL-184's stress shape (~2,400 unfinished).

| Dataset | Nodes | Shape |
| --- | --- | --- |
| `accept-5000` | 5,000 | OL-183 acceptance: ≤ 800 unfinished, over half the lines fully done (hidden by default) |
| `stress-5000` | 5,000 | OL-184 stress: ~2,400 unfinished |
| `1000` / `2500` / `10000` | 1,000 / 2,500 / 10,000 | stress shape, scale curve |
| `big-line` | 1,000 | one single line of 1,000 tasks |
| `empty` | 0 | harness self-check: the scenario must report `invalid`, never numbers |

Every dataset: six projects (tooling → art/server/audio → client → level),
lines of 30–40 tasks with 2–3 sub-line layers, 1–2 in-line prerequisites per
task, cross-line prerequisites strictly down the production flow
(tooling lines get none), no ancestor↔descendant edges (the backend refuses
them), dependency summaries computed the backend way (ancestral closure,
`done`-only satisfaction), nodes/edges/projects sorted by id like the real
endpoint, cancelled-but-still-blocking cases, run summaries on in-progress
tasks, and fully-done lines the default view hides.

## What the DAG scenario measures

The page under test is `/{workspace}/issues` with the DAG view preselected
(through the persisted surface-view preference). All requests are answered
from a fixed route table; anything unknown invalidates the sample.

| Report field | Definition |
| --- | --- |
| `fetch_ms` | Graph request sent → response ended, from the page's own resource timing (one request). Local synthetic transport — real-network numbers are OL-275's. |
| `parse_ms` / `parse_and_validate_ms` | `JSON.parse` alone, and `JSON.parse` + `IssueGraphSchema.parse`, on the exact graph bytes. Measured in the Playwright process against the same schema module the app bundles — the app's in-flight validation is not separately observable. |
| `layout_ms` | Layout worker `postMessage` → result committed (next frame after the pending skeleton disappears), per requestId — instrumentation wraps `Worker` before the app boots. Max over the run's committed layout requests. |
| `first_interactive_ms` | Navigation start → canvas has rendered cards AND the layout-pending skeleton is gone AND the toolbar is visible, each timestamped in-page (MutationObserver + performance.now), not by Playwright polling. |
| `pan` / `zoom` | Scripted drag / Ctrl+wheel gestures, ~4 s each. Pan starts from a verified bare-pane point (cards are `nopan`) and is discarded as `invalid` if the viewport transform never changed; rAF frame intervals → p50/p95/max ms, long-frame count, avg FPS. Stalled frames are counted, not trimmed. |
| `click` | In-page: real pointer events on a visible card's body (never the group header), timed from pointerdown to the frame after the toolbar's selection label appears; every sample starts from a cleared selection. ≥ 3 samples → p50/p95 ms, else `timeout`/`invalid`. |

Outcomes that are not durations are reported as strings: `timeout` when a
budget expired, `invalid` when nothing rendered or the sample was
contaminated (unmocked requests, page errors). A report never shows a fast
number for an empty page.

Outcomes: if the canvas renders but no card ever appears, the report is
`invalid` (not a timeout) and no gesture or click numbers are produced;
unmocked API requests, external requests and page errors also make the sample
`invalid`; a per-measurement budget expiry lands in `timed_out_at` and the
overall `status` becomes `timeout`.

The report records machine info (browser, Node, platform, CPU count, CPU
model, memory) and `throttle_cpu`; `fixture_stats` carries the dataset's
shape statistics and `fixture_digest` identifies the exact bytes.

**CPU-throttle caveat**: `PERF_THROTTLE_CPU` uses CDP
`Emulation.setCPUThrottlingRate` on the page session. Whether it extends to
the ELK layout worker has not been verified — treat throttled `layout_ms` as
page-side only until that is checked on your setup.

Adding steps (e.g. "enter a task line" timing): put the step in
`e2e/perf/dag-view.spec.ts` between the section markers, emit one more report
field, and document it in the table above. Keep the invariant — every field
is a number or `timeout`/`invalid`, never a silent zero.

## When to run it

Nothing runs this automatically. The routine guard is the component test from
#8260, which pins the exact failure mode behind MUL-7227 — a streamed message
replacing the summary's DOM node — and runs with the normal suite.

Run the comparison yourself, or through the **UI performance report** workflow
(`workflow_dispatch`, base and head refs as inputs), when a change touches
summary animation, long lists, transcript rendering or global styles — and
attach the report to the PR. Run the DAG scenario when a change touches the
DAG view, the graph API client, or the layout worker. The cost of doing it by
hand instead of on every PR is that a regression outside those areas will not
be caught automatically.

## What it costs

On a GitHub-hosted `ubuntu-latest` runner the comparison took 340.5 s: 291.5 s
for the two production builds, 26 s for the two measurements, the rest install
and startup — plus checkout, dependency and Chromium setup around it. The job is
capped at 15 minutes. Locally, a repeat comparison whose builds come out of the
turbo cache takes under a minute; the report says when a build was restored.
The DAG scenario adds roughly half a minute per dataset on an idle machine;
large datasets on the current view can exceed every budget and report
`timeout` — that is the baseline being measured, not a harness failure.

## Reading the result

`typing_elapsed_ms` is the primary number of the typing scenario: how long
the user waits from the first keystroke until the editor holds the whole
string, main-thread queueing included. `recalc_style_ms`, `layout_ms`,
`task_ms` and the long-task counters say where the time went.

For the DAG scenario, `first_interactive_ms` is the primary number, with
`pan`/`zoom`/`click` as the interaction budget (OL-183: first screen
operable within 2 s, pan/zoom ≥ 30 FPS, click under 100 ms).

Two things are not the same as a fast run, and the scenario reports them as
`invalid` or `timeout` rather than as a duration: messages that never reached
the UI, and a composer that did not end up holding every character. An empty
page types very quickly.

One sample per ref. Read a small difference as noise until a second run says
otherwise. Locally the spread across three runs of one build was around 1%; on
CI, comparing two refs with no product difference between them came out 2%
apart on typing and on style recalculation. A threshold needs more CI samples
than that before it can be trusted.

## Changing the fixture

`fixtures/typing-under-live-runs.ts` generates every byte the typing scenario
feeds the product, and the report carries the fixture version and a digest of
it. Bump `FIXTURE_VERSION` whenever the generated bytes change — two runs are
only comparable when the digests match, which the comparison report states.

The DAG scenario's data comes from the shared generator above; bump
`ISSUE_GRAPH_FIXTURE_VERSION` there whenever the generated graphs change.

Do not add DOM to the page to keep the pressure up. A future virtualization
change that legitimately renders fewer nodes should show up as fewer nodes.
