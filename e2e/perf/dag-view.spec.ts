/**
 * DAG view performance scenario (OL-278).
 *
 * Measures the issues page's DAG view against synthetic graph data of the
 * shapes OL-183 defined: fetch, parse+validate, layout, first-interactive,
 * pan/zoom frame rate, card-click response, task-line entry and focus mode.
 * Navigation has overview, line and focus levels; the initial interaction
 * sections run on whichever level painted first (a dataset with a single
 * visible line auto-enters it). Everything except HTTP is the real
 * production page — routing, TanStack Query, the ELK scene-layout workers,
 * React Flow. Like the typing scenario, requests are answered from a fixed
 * table: anything outside it invalidates the sample.
 *
 * All in-page measurements use instrumentation injected before the app boots
 * (rAF sampling, Worker wrapping, MutationObserver), so the numbers are
 * frame-clock based, not Playwright-polling based.
 *
 * The result is a report, not a gate. `timeout` and `invalid` are outcomes,
 * never durations — an empty page is not fast.
 *
 *   pnpm exec playwright test --config=playwright.perf.config.ts e2e/perf/dag-view.spec.ts
 *   PERF_DATASET=stress-5000 PERF_THROTTLE_CPU=4 PERF_REPORT_PATH=report.json ...
 */
import { mockDagGraph, WORKSPACE_SLUG } from "../dag-graph-fixture";
import { expect, test } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import os from "node:os";
import {
  ISSUE_GRAPH_FIXTURE_DATASETS,
  ISSUE_GRAPH_FIXTURE_VERSION,
  analyzeIssueGraphFixture,
  buildIssueGraphFixture,
  issueGraphFixtureDigest,
  type IssueGraphFixtureDatasetName,
} from "@multica/core/issues/testing/issue-graph-fixture";
import { createDagModelIndex } from "@multica/core/issues/dag/model-index";
import { dagDependencyClosure } from "@multica/core/issues/dag/traversal";
import { IssueGraphSchema } from "@multica/core/api";

test.setTimeout(600_000);

// Explicit opt-in: a bare `playwright test --config=playwright.perf.config.ts`
// (as CI or perf-compare may run it) must not pick up a multi-minute DAG
// measurement by accident. PERF_DATASET selects the graph; PERF_DATASET=none
// skips the scenario entirely.
const DATASET = (process.env.PERF_DATASET ?? "none") as IssueGraphFixtureDatasetName | "none";
const SKIP = DATASET === "none";
if (!SKIP && !(DATASET in ISSUE_GRAPH_FIXTURE_DATASETS)) {
  throw new Error(`unknown PERF_DATASET ${DATASET}`);
}
/** CDP CPU throttle factor; 1 = unthrottled. NOTE: applies to the page (and
 * its dedicated workers, per CDP semantics) — see README before trusting
 * throttled layout numbers. */
const THROTTLE = Number(process.env.PERF_THROTTLE_CPU ?? 1);
const CONFIG = SKIP ? null : ISSUE_GRAPH_FIXTURE_DATASETS[DATASET as IssueGraphFixtureDatasetName]!;
/** Optional stress modifiers applied after first paint: toolbar switches to
 *  turn on (e.g. PERF_DAG_SWITCHES=completed,satisfied for the OL-284 stress
 *  overview) and a line to enter before the gesture measurements
 *  (PERF_ENTER_LINE=largest, or an explicit overview card id). */
const SWITCHES = (process.env.PERF_DAG_SWITCHES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const ENTER_LINE = process.env.PERF_ENTER_LINE ?? "";
/** How long the scripted pan and zoom gestures each run. */
const GESTURE_MS = 4_000;
/** Measured click samples. */
const CLICK_SAMPLES = 10;
/** Beyond this a measurement is `timeout`, not a duration. Configurable so a
 * deliberately short budget can exercise the timeout path quickly. */
const LOAD_LIMIT_MS = Number(process.env.PERF_LOAD_LIMIT_MS ?? 180_000);
/** Grace period after the graph response arrives with no layout request, no
 * loading state, no skeleton and no canvas before concluding "no content".
 * Generous on purpose: parse + validate + projection sit between response
 * and the first layout request, and CPU throttling stretches them. */
const EMPTY_GRACE_MS = 8_000;

test.use({
  viewport: { width: 1600, height: 1050 },
  locale: "en-US",
  colorScheme: "light",
  serviceWorkers: "block",
});

/** Writes the report wherever the run can see it, whatever the outcome. */
function emit(report: Record<string, unknown>) {
  const out = process.env.PERF_REPORT_PATH;
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify(report, null, 2));
  }
  test.info().annotations.push({ type: "perf", description: JSON.stringify(report) });
  // eslint-disable-next-line no-console
  console.log(`PERF_REPORT ${JSON.stringify(report)}`);
}

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, at)]!);
};

/**
 * Injected before the app boots. Owns these measurements:
 *  - rAF frame-interval sampling (`__dagSample`);
 *  - scene-layout worker timing: Worker#postMessage → message received, keyed
 *    by the requestId the DAG scene-layout protocol carries (`__dagLayouts`),
 *    covering the per-kind workers ("overview"/"line"/"focus");
 *  - first-occurrence markers via MutationObserver for cards, toolbar and
 *    the pending-skeleton disappearing (`__dagMarks`), all on
 *    performance.now();
 *  - an in-page click prober that dispatches a real pointer click and waits
 *    for the toolbar selection label to appear, then resolves on the next
 *    animation frame (`__dagClick`);
 *  - an in-page enter-line prober that double-clicks the first visible
 *    overview line card and resolves on the frame after the line level
 *    renders its first task card (`__dagEnterLine`).
 */
const INSTRUMENT = `
  (() => {
    const perf = () => performance.now();
    // ---- rAF frame sampling -------------------------------------------------
    const frames = { intervals: [], sampling: false };
    window.__dagFrames = frames;
    window.__dagSample = (on) => { frames.sampling = on; if (on) frames.intervals = []; };
    let lastFrame = null;
    const tick = (now) => {
      if (frames.sampling) {
        if (lastFrame != null) frames.intervals.push(now - lastFrame);
        lastFrame = now;
      } else lastFrame = null;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // ---- layout worker timing ----------------------------------------------
    // The scene runner (createDagSceneRunner) keeps one Worker per scene kind
    // ("overview"/"line"/"focus") and posts {requestId, input, fallback?};
    // the worker answers {requestId, result, error}. Each request is timed
    // postMessage → response (message event, recorded in the constructor so
    // every worker instance is covered) → committed (the frame the pending
    // skeleton disappeared, i.e. the React commit of the result). A response
    // carrying 'error' is recorded as such. Results served from the runner's
    // LRU never touch a worker, so they simply do not appear here. A
    // deadline-fallback repost reuses the requestId: the response is
    // attributed to the first open record, so the measured span includes the
    // fallback wait the user sat through.
    const layouts = [];
    window.__dagLayouts = layouts;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          const data = event.data;
          if (!data || typeof data.requestId !== "number") return;
          const record = layouts.find((l) => l.requestId === data.requestId && l.respondedAt == null);
          if (!record) return;
          record.respondedAt = perf();
          record.error = typeof data.error === "string" && data.error ? data.error : null;
        });
      }
      postMessage(data) {
        try {
          if (data && typeof data.requestId === "number") {
            layouts.push({
              requestId: data.requestId,
              kind: data.input && typeof data.input.kind === "string" ? data.input.kind : null,
              postedAt: perf(), respondedAt: null, error: null, committedAt: null,
            });
          }
        } catch {}
        return super.postMessage(data);
      }
    };
    // ---- first-occurrence markers -------------------------------------------
    const marks = { firstCardAt: null, toolbarAt: null, skeletonGoneAt: null, graphCanvasAt: null };
    window.__dagMarks = marks;
    const has = (sel) => !!document.querySelector(sel);
    const observe = () => {
      if (marks.firstCardAt == null && has('[data-dag-overview-card],[data-dag-task]')) marks.firstCardAt = perf();
      if (marks.toolbarAt == null && has('[data-dag-toolbar]')) marks.toolbarAt = perf();
      if (marks.graphCanvasAt == null && has('[data-dag-canvas]')) marks.graphCanvasAt = perf();
      if (marks.firstCardAt != null && marks.skeletonGoneAt == null && !has('[data-slot="skeleton"]')) {
        marks.skeletonGoneAt = perf();
      }
      if (marks.skeletonGoneAt != null && marks.toolbarAt != null) return; // observer can stop
      setTimeout(observe, 16);
    };
    observe();
    // Layout commit frame: a request is "committed" when the pending skeleton
    // disappeared on a frame after its response arrived. This is the app
    // applying the result (use-dag-scene-layout clears pending on receipt and
    // React commits on the next render pass). Only the first paint shows the
    // skeleton — a level switch keeps the previous scene painted while its
    // layout runs — so later requests stay uncommitted here; the enter-line
    // section measures that path instead.
    const commitWatcher = () => {
      for (const record of layouts) {
        if (record.committedAt == null && record.error == null
          && marks.skeletonGoneAt != null && record.respondedAt != null
          && record.respondedAt <= marks.skeletonGoneAt) {
          record.committedAt = marks.skeletonGoneAt;
        }
      }
      requestAnimationFrame(commitWatcher);
    };
    requestAnimationFrame(commitWatcher);
    // ---- in-page click prober ------------------------------------------------
    window.__dagClick = (x, y) => new Promise((resolve) => {
      const startedAt = perf();
      let settled = false;
      const finish = (outcome, at) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve({ outcome, elapsed: Math.round(at - startedAt) });
      };
      const labelSeen = () => !!document.querySelector('[data-dag-toolbar] [data-dag-label]');
      const observer = new MutationObserver(() => {
        if (labelSeen()) {
          // Resolved when the label is on screen AND the next frame ran.
          requestAnimationFrame(() => finish("selected", perf()));
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const target = document.elementFromPoint(x, y);
      // 'view: window' is required: d3's drag/zoom handlers read
      // event.view.document, which is null on dispatched events without it.
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window, pointerId: 1, isPrimary: true };
      target?.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
      target?.dispatchEvent(new MouseEvent("mousedown", opts));
      target?.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
      target?.dispatchEvent(new MouseEvent("mouseup", opts));
      target?.dispatchEvent(new MouseEvent("click", opts));
      setTimeout(() => finish("timeout", perf()), 10_000);
    });
    // Clear selection the same way a user would: click empty canvas pane.
    window.__dagClearSelection = () => new Promise((resolve) => {
      const pane = document.querySelector(".react-flow__pane");
      if (!pane) { resolve(false); return; }
      const rect = pane.getBoundingClientRect();
      const x = rect.x + 8, y = rect.y + rect.height - 8;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window, pointerId: 2 };
      pane.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 2, pointerType: "mouse" }));
      pane.dispatchEvent(new MouseEvent("mousedown", opts));
      pane.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 2, pointerType: "mouse" }));
      pane.dispatchEvent(new MouseEvent("mouseup", opts));
      pane.dispatchEvent(new MouseEvent("click", opts));
      const started = perf();
      const check = () => {
        if (!document.querySelector('[data-dag-toolbar] [data-dag-label]')) resolve(true);
        else if (perf() - started > 5_000) resolve(false);
        else requestAnimationFrame(check);
      };
      check();
    });
    // Locate a point on the bare pane (empty canvas) near the centre.
    window.__dagPanePoint = () => {
      const pane = document.querySelector(".react-flow__pane");
      if (!pane) return null;
      const rect = pane.getBoundingClientRect();
      for (let radius = 0; radius <= Math.min(rect.width, rect.height) / 2; radius += 24) {
        for (const [dx, dy] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
          const x = rect.x + rect.width / 2 + dx;
          const y = Math.min(rect.y + rect.height - 40, rect.y + rect.height / 2 + dy);
          const hit = document.elementFromPoint(x, y);
          if (hit === pane) return { x, y };
        }
      }
      return null;
    };
    // Cards actually visible in the viewport, with a clickable body point.
    // Overview cards and task cards have no header buttons, but a candidate
    // point is still rejected when it is outside the card or lands on a
    // button, so the probe clicks card body only at any zoom level.
    window.__dagVisibleCards = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const cards = [...document.querySelectorAll('.react-flow__node')]
        .filter((el) => el.querySelector('[data-dag-overview-card],[data-dag-task]'));
      const out = [];
      for (const el of cards) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
        const candidates = [
          [rect.width / 2, Math.min(rect.height - 12, 96)],
          [rect.width / 2, rect.height - 10],
          [rect.width / 4, Math.min(rect.height - 12, 96)],
          [(rect.width * 3) / 4, Math.min(rect.height - 12, 96)],
          [rect.width / 2, Math.min(rect.height - 12, 96) + 20],
          [10, Math.min(rect.height - 12, 96)],
        ];
        for (const [dx, dy] of candidates) {
          const x = rect.x + Math.min(dx, rect.width - 4);
          const y = rect.y + Math.min(dy, rect.height - 4);
          if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && (el === hit || el.contains(hit)) && !hit.closest("button")) {
            out.push({ x, y, id: el.getAttribute("data-id") });
            break;
          }
        }
      }
      return out;
    };
    // Enter-line prober: a real double-click on the centre of the first
    // visible overview line card (or on the given cardId), resolved on the
    // frame after the line level renders its first task card. "invalid" when
    // no line card is on screen (e.g. the dataset auto-entered its single
    // line, or the graph painted only standalone cards).
    window.__dagEnterLine = (cardId) => new Promise((resolve) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      let target = null, x = 0, y = 0;
      const selector = cardId
        ? '[data-dag-overview-card="' + cardId + '"]'
        : '[data-dag-overview-card][data-dag-kind="line"]';
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (hit && (el === hit || el.contains(hit))) { target = hit; x = cx; y = cy; break; }
      }
      if (!target) { resolve({ outcome: "invalid", elapsed: null }); return; }
      const startedAt = perf();
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        // No duration on failure: a number must mean the line rendered.
        resolve({ outcome, elapsed: outcome === "entered" ? Math.round(perf() - startedAt) : null });
      };
      const taskSeen = () => !!document.querySelector('[data-dag-task]');
      const observer = new MutationObserver(() => {
        if (taskSeen()) {
          // Resolved when the first task card is on screen AND the next frame ran.
          requestAnimationFrame(() => finish("entered"));
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // 'view: window' is required: d3's drag/zoom handlers read
      // event.view.document, which is null on dispatched events without it.
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window, pointerId: 1, isPrimary: true };
      for (let click = 0; click < 2; click++) {
        target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
        target.dispatchEvent(new MouseEvent("mousedown", opts));
        target.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
        target.dispatchEvent(new MouseEvent("mouseup", opts));
        target.dispatchEvent(new MouseEvent("click", opts));
      }
      target.dispatchEvent(new MouseEvent("dblclick", opts));
      setTimeout(() => finish("timeout"), 10_000);
    });
    // Live viewport transform, for pan verification.
    window.__dagViewport = () =>
      document.querySelector(".react-flow__viewport")?.getAttribute("style") ?? null;
  })();
`;

const dagTest = SKIP ? test.skip : test;
dagTest(`DAG view performance (${DATASET})`, async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const graph = buildIssueGraphFixture(CONFIG!);
  const stats = analyzeIssueGraphFixture(graph);
  const graphJson = JSON.stringify(graph);
  const pageErrors: string[] = [];
  let graphBodyBytes = 0;

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  const { unknownRequests, external } = await mockDagGraph(context, origin, graph, {
    onGraph: (bytes) => { graphBodyBytes = bytes; },
  });
  await context.addInitScript(INSTRUMENT);

  if (THROTTLE > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }

  const invalid: string[] = [];
  const timedOut: Record<string, true> = {};

  // ---- 1. Navigate: fetch → parse → layout → first interactive ------------
  await page.goto(`${origin}/${WORKSPACE_SLUG}/issues`, { waitUntil: "domcontentloaded", timeout: LOAD_LIMIT_MS });

  // Page-side liveness snapshot: first-occurrence marks, live layout records,
  // and whether the graph response has arrived (resource timing) plus any
  // loading/skeleton/canvas state right now.
  type Marks = { firstCardAt: number | null; toolbarAt: number | null; skeletonGoneAt: number | null; graphCanvasAt: number | null };
  const snapshot = () => page.evaluate(() => ({
    marks: (window as unknown as { __dagMarks: Marks }).__dagMarks,
    layouts: (window as unknown as { __dagLayouts: { requestId: number; kind: string | null; postedAt: number; respondedAt: number | null; error: string | null; committedAt: number | null }[] }).__dagLayouts,
    graphArrived: performance.getEntriesByType("resource").some((e) => e.name.includes("/issues/graph")),
    // The layout-pending skeleton specifically: the empty state keeps a
    // persistent role=status, so that selector cannot mean "still loading".
    pending: !!document.querySelector('[data-slot="skeleton"]'),
  }));
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  // Wait for first interactive (cards + skeleton gone + toolbar), with two
  // early exits decided by what the PAGE shows, never by Node-side knowledge:
  //  - a layout request errored → invalid (the view replaced everything with
  //    an error alert; no duration can exist);
  //  - the graph response arrived and a full grace period passed with no
  //    layout request, no pending state, no skeleton, no canvas → invalid
  //    (nothing to measure; this is how an empty graph concludes quickly).
  const deadline = Date.now() + LOAD_LIMIT_MS;
  let snap: Snapshot | null = null;
  let emptySince: number | null = null;
  while (Date.now() < deadline) {
    snap = await snapshot();
    const errored = snap.layouts.find((l) => l.error != null);
    if (errored) {
      invalid.push(`layout error: ${errored.error.slice(0, 120)}`);
      break;
    }
    const done = snap.marks.firstCardAt != null && snap.marks.skeletonGoneAt != null && snap.marks.toolbarAt != null;
    if (done) break;
    if (snap.graphArrived && snap.layouts.length === 0 && !snap.pending
      && snap.marks.firstCardAt == null && snap.marks.graphCanvasAt == null) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= EMPTY_GRACE_MS) {
        invalid.push("graph arrived but nothing rendered: no layout request, no canvas");
        break;
      }
    } else {
      emptySince = null;
    }
    await page.waitForTimeout(250);
  }
  if (!snap) snap = await snapshot();
  const marks: Marks = snap.marks;

  // Budget expired without concluding: classify from page state.
  if (!invalid.length && marks.firstCardAt == null && snap.layouts.length > 0) {
    // A layout request was posted and never committed — the layout is still
    // computing (or its response never arrived). That is a timeout.
    timedOut.first_interactive = true;
  } else if (!invalid.length && marks.firstCardAt == null) {
    // No layout request, no cards, no error marker within the whole budget.
    invalid.push("no layout request and no cards within budget");
  } else if (!invalid.length && (marks.skeletonGoneAt == null || marks.toolbarAt == null)) {
    // Cards appeared but a later first-interactive stage never completed.
    timedOut.first_interactive = true;
  }
  const firstInteractiveMs = marks.firstCardAt != null && marks.skeletonGoneAt != null && marks.toolbarAt != null
    ? Math.round(Math.max(marks.firstCardAt, marks.skeletonGoneAt, marks.toolbarAt))
    : null;

  // Fetch timing from the page's own resource timing (single request).
  const resourceTiming = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .map((e) => ({ name: e.name, start: e.startTime, end: (e as PerformanceResourceTiming).responseEnd }))
      .filter((e) => e.name.includes("/issues/graph")),
  );
  const graphTiming = resourceTiming[0];
  const fetchMs = graphTiming ? Math.round(graphTiming.end - graphTiming.start) : null;

  // Parse + validate: JSON.parse AND IssueGraphSchema.parse on the same
  // bytes, in Node (the schema is the same module the app bundles; recorded
  // here because the app's own in-flight validation is not observable
  // separately — see README). Each measurement is warmed once first so the
  // comparison is not skewed by one path having compiled the parser.
  JSON.parse(graphJson);
  IssueGraphSchema.parse(JSON.parse(graphJson));
  const validateMs = (() => {
    const started = performance.now();
    IssueGraphSchema.parse(JSON.parse(graphJson));
    return Math.round(performance.now() - started);
  })();
  const parseMs = (() => {
    const started = performance.now();
    JSON.parse(graphJson);
    return Math.round(performance.now() - started);
  })();

  // Layout timing per requestId: postMessage → response (worker message) and
  // postMessage → committed (frame the pending skeleton disappeared after the
  // response). Both are read from the in-page records.
  const layouts = (await snapshot()).layouts;
  const responded = layouts.filter((l) => l.respondedAt != null);
  const committed = layouts.filter((l) => l.committedAt != null);
  const layoutMs = committed.length
    ? Math.round(Math.max(...committed.map((l) => l.committedAt! - l.postedAt)))
    : null;
  const layoutRespondMs = responded.length
    ? Math.round(Math.max(...responded.map((l) => l.respondedAt! - l.postedAt)))
    : null;

  // Per-measurement outcomes. Gestures only make sense once cards exist.
  const cardsPresent = marks.firstCardAt != null;

  // ---- 1b. Optional stress switches ----------------------------------------
  // The OL-284 stress overview turns on both display switches: completed
  // lines re-enter the layout (deadline fallback is an expected outcome here),
  // satisfied dependencies arrive as re-layout-free overlays.
  const switchesApplied: string[] = [];
  if (cardsPresent && SWITCHES.length) {
    for (const entry of SWITCHES) {
      if (entry === "completed") {
        await page.getByRole("button", { name: /Show completed/ }).first().click();
      } else if (entry === "satisfied") {
        await page.locator("[data-dag-show-satisfied]").click();
      } else {
        invalid.push(`unknown PERF_DAG_SWITCHES entry: ${entry}`);
        continue;
      }
      switchesApplied.push(entry);
    }
    // Settle: any re-layout finishes (its toolbar indicator clears) and the
    // painted card count holds steady across two polls.
    await page.waitForTimeout(400);
    await page
      .getByText(/Computing layout/)
      .waitFor({ state: "hidden", timeout: LOAD_LIMIT_MS })
      .catch(() => undefined);
    let lastCount = -1;
    const settleDeadline = Date.now() + 90_000;
    while (Date.now() < settleDeadline) {
      const pending = await page.getByText(/Computing layout/).count();
      const count = await page
        .locator("[data-dag-overview-card],[data-dag-task]")
        .count();
      if (!pending && count > 0 && count === lastCount) break;
      lastCount = count;
      await page.waitForTimeout(500);
    }
  }

  // ---- 1c. Optional: enter a line before the gestures -----------------------
  // "largest" resolves to the fixture's biggest task line by member count.
  let enteredLine: string | null = null;
  if (cardsPresent && ENTER_LINE) {
    let cardId: string | null = ENTER_LINE;
    if (ENTER_LINE === "largest") {
      const parentOf = new Map(graph.nodes.map((node) => [node.id, node.parent_issue_id]));
      const finished = (status: string) => status === "done" || status === "cancelled";
      const counts = new Map<string, number>();
      const allFinished = new Map<string, boolean>();
      for (const node of graph.nodes) {
        let root = node.id;
        let parent = node.parent_issue_id;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          root = parent;
          parent = parentOf.get(parent) ?? null;
        }
        counts.set(root, (counts.get(root) ?? 0) + 1);
        if (!finished(node.status)) allFinished.set(root, false);
        else if (!allFinished.has(root)) allFinished.set(root, allFinished.get(root) ?? true);
      }
      // Only lines with an overview card: fully finished lines hide by default.
      let best: string | null = null;
      let bestCount = -1;
      for (const [id, count] of counts) {
        if (allFinished.get(id) !== false) continue;
        if (count > bestCount) {
          best = id;
          bestCount = count;
        }
      }
      cardId = best ? `issue:${best}` : null;
    }
    if (cardId) {
      const enter = await page.evaluate(
        (id) =>
          (window as unknown as { __dagEnterLine: (cardId?: string) => Promise<{ outcome: string; elapsed: number | null }> }).__dagEnterLine(id),
        cardId,
      );
      if (enter.outcome === "entered") enteredLine = cardId;
      else invalid.push(`enter line ${cardId}: ${enter.outcome}`);
    }
  }

  // ---- 2. Pan and zoom frame rate ------------------------------------------
  const frameStats = async (run: () => Promise<void>) => {
    await page.evaluate(() => {
      (window as unknown as { __dagSample: (on: boolean) => void }).__dagSample(true);
    });
    await run();
    const intervals = await page.evaluate(
      () => (window as unknown as { __dagFrames: { intervals: number[] } }).__dagFrames.intervals,
    );
    await page.evaluate(() => {
      (window as unknown as { __dagSample: (on: boolean) => void }).__dagSample(false);
    });
    // Every interval counts, including stalls: a janked gesture must show up
    // as a long max, not a trimmed average.
    const frames = intervals.filter((i) => i > 0);
    if (frames.length < 10) return null;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    return {
      frames: frames.length,
      p50_ms: percentile(frames, 50),
      p95_ms: percentile(frames, 95),
      max_ms: Math.round(Math.max(...frames)),
      long_frames_100ms: frames.filter((i) => i >= 100).length,
      avg_fps: Math.round((1000 / avg) * 10) / 10,
    };
  };

  /** "invalid" when the gesture provably did nothing (the viewport transform
   * never changed at any sampled moment), "timeout" when frames never came,
   * stats otherwise. The transform is sampled throughout the gesture, not
   * only at the end: an alternating zoom that returns to its start must still
   * count as a real gesture. */
  const gesture = async (label: string, run: () => Promise<void>) => {
    if (!cardsPresent) return "invalid" as const;
    const before = await page.evaluate(() => (window as unknown as { __dagViewport: () => string | null }).__dagViewport());
    const seen = new Set<string>([before ?? "null"]);
    const sampler = setInterval(() => {
      void page.evaluate(() => (window as unknown as { __dagViewport: () => string | null }).__dagViewport())
        .then((style) => seen.add(style ?? "null"))
        .catch(() => undefined);
    }, 100);
    const result = await frameStats(run);
    clearInterval(sampler);
    if (result === null) {
      timedOut[label] = true;
      return "timeout" as const;
    }
    if (seen.size <= 1) return "invalid" as const;
    return result;
  };

  // Pan starts from a bare-pane point (cards carry `nopan`).
  const panePoint = await page.evaluate(() => (window as unknown as { __dagPanePoint: () => { x: number; y: number } | null }).__dagPanePoint());
  let pan: Record<string, number | null> | string;
  let zoom: Record<string, number | null> | string;
  if (!cardsPresent) {
    pan = "invalid";
    zoom = "invalid";
  } else if (!panePoint) {
    invalid.push("no empty canvas point found: pan not measurable");
    pan = "invalid";
    zoom = "invalid";
  } else {
    pan = await gesture("pan", async () => {
      await page.mouse.move(panePoint.x, panePoint.y);
      await page.mouse.down();
      const panStart = Date.now();
      let step = 0;
      while (Date.now() - panStart < GESTURE_MS) {
        const phase = Math.floor((Date.now() - panStart) / 800) % 2 === 0 ? 1 : -1;
        await page.mouse.move(panePoint.x + step * phase, panePoint.y + step * phase * 0.6, { steps: 4 });
        step = (step + 14) % 120;
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    });
    zoom = await gesture("zoom", async () => {
      // The wheel must land with the pointer on the canvas: hover a bare-pane
      // point first, exactly like a user would.
      await page.mouse.move(panePoint.x, panePoint.y);
      const zoomStart = Date.now();
      let tick = 0;
      while (Date.now() - zoomStart < GESTURE_MS) {
        // Ctrl+wheel is the canvas's zoom activation key.
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, tick % 2 === 0 ? -120 : 120);
        await page.keyboard.up("Control");
        tick += 1;
        await page.waitForTimeout(90);
      }
    });
  }

  // ---- 3. Click response ----------------------------------------------------
  // In-page: real pointer events on visible cards' bodies, timed from
  // pointerdown to the frame after the toolbar's selection label appears.
  // Each sample starts from a cleared selection.
  const clickSamples: number[] = [];
  let clickTimeouts = 0;
  let clickClearedFailed = 0;
  let clickOutcome: Record<string, number | null> | string = "invalid";
  if (cardsPresent) {
    let anySelected = false;
    for (let i = 0; i < CLICK_SAMPLES; i++) {
      const cards = await page.evaluate(() => (window as unknown as { __dagVisibleCards: () => { x: number; y: number }[] }).__dagVisibleCards());
      if (!cards.length) break;
      const card = cards[Math.floor((i * cards.length) / CLICK_SAMPLES)]!;
      // Clear any previous selection first, and prove it is gone. A failed
      // clear invalidates the sample: a leftover label would satisfy the
      // next probe's observer instantly and record a fake fast sample.
      const cleared = await page.evaluate(() => (window as unknown as { __dagClearSelection: () => Promise<boolean> }).__dagClearSelection());
      if (!cleared) {
        clickClearedFailed += 1;
        continue;
      }
      const result = await page.evaluate(
        ({ x, y }) => (window as unknown as { __dagClick: (x: number, y: number) => Promise<{ outcome: string; elapsed: number }> }).__dagClick(x, y),
        card,
      );
      if (result.outcome === "selected") {
        clickSamples.push(result.elapsed);
        anySelected = true;
      } else {
        clickTimeouts += 1;
      }
    }
    if (clickClearedFailed) invalid.push(`selection clear failed on ${clickClearedFailed} samples`);
    clickOutcome = clickSamples.length >= 3
      ? { samples: clickSamples.length, timeouts: clickTimeouts, p50_ms: percentile(clickSamples, 50), p95_ms: percentile(clickSamples, 95) }
      : anySelected || clickTimeouts ? "timeout" : "invalid";
    if (clickOutcome === "timeout") timedOut.click = true;
  }

  // ---- 4. Enter a line -------------------------------------------------------
  // In-page: real double-click on the first visible overview line card, timed
  // to the frame after the line level renders its first task card (OL-183
  // budget: 300 ms). "invalid" when no line card is visible — e.g. a dataset
  // whose single visible line was auto-entered. Runs last among the
  // interactive sections; afterwards the view returns to the overview so
  // collection sees a settled page.
  let enterLineMs: number | string = "invalid";
  if (cardsPresent) {
    const enter = await page.evaluate(
      () => (window as unknown as { __dagEnterLine: () => Promise<{ outcome: string; elapsed: number | null }> }).__dagEnterLine(),
    );
    if (enter.outcome === "entered" && enter.elapsed != null) {
      enterLineMs = enter.elapsed;
    } else if (enter.outcome === "timeout") {
      enterLineMs = "timeout";
      timedOut.enter_line = true;
    }
    if (enter.outcome !== "invalid") {
      // The back button renders as soon as the line level opens; click()
      // waits for it. Best effort — a failed restore must not mask the
      // measurement.
      await page.locator("[data-dag-back]").click({ timeout: 5_000 }).catch(() => undefined);
    }
  }

  // ---- 5. Focus mode: typical (~25 closure members) and largest closure ----
  // Find seeds outside the browser measurement. Model construction, layout,
  // worker transfer and rendering after the button click remain timed.
  const focusIndex = createDagModelIndex(IssueGraphSchema.parse(graph));
  const candidates = [...focusIndex.issues.values()].flatMap((node) => {
    const root = focusIndex.rootOf.get(node.id)!;
    const closure = new Set([
      ...dagDependencyClosure(focusIndex.traversal, [node.id], "upstream"),
      ...dagDependencyClosure(focusIndex.traversal, [node.id], "downstream"),
    ]);
    return [{ id: node.id, identifier: node.identifier, lineId: root, closure_count: closure.size, is_frame: focusIndex.forest.children.has(node.id), hidden_line: focusIndex.visibility.hiddenRoots.has(root) }];
  });
  const typical = candidates.filter((candidate) => !candidate.hidden_line && !candidate.is_frame && candidate.id !== candidate.lineId).sort((a, b) => Math.abs(a.closure_count - 25) - Math.abs(b.closure_count - 25))[0];
  const largest = [...candidates].sort((a, b) => b.closure_count - a.closure_count)[0];
  const focusResults: Record<string, unknown> = {};
  for (const [label, target] of [["typical", typical], ["largest", largest]] as const) {
    if (!target || !cardsPresent) { focusResults[label] = "invalid"; continue; }
    if (await page.locator("[data-dag-back]").count()) await page.locator("[data-dag-back]").click();
    await expect(page.locator('[data-dag-level="overview"]')).toBeVisible();
    if (label === "largest") {
      const completed = page.getByRole("button", { name: /^Show completed/ });
      if (await completed.getAttribute("aria-pressed") === "false") await completed.click();
    }
    await expect(page.getByText("Computing layout…", { exact: true })).toHaveCount(0, { timeout: 10_000 });
    // The preceding pan/zoom sample may leave this line outside the viewport;
    // fit first so Flow's viewport culling also mounts the target card.
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const card = page.locator(`[data-dag-overview-card="issue:${target.lineId}"]`);
    await card.waitFor({ timeout: 20_000 });
    // Prepare a precise seed through the actual overview -> line -> task UI.
    await card.dispatchEvent("click");
    await expect(page.locator("[data-dag-label]")).toBeVisible();
    await card.dispatchEvent("dblclick");
    // Entering restores the line's remembered viewport — after the gesture
    // samples it can sit anywhere in a very wide scene, and React Flow's
    // viewport culling keeps the target card unmounted. Sweep a grid with
    // the public wheel-pan until it mounts.
    const task = page.locator(`[${target.is_frame ? "data-dag-frame-header" : "data-dag-task"}="${target.is_frame ? target.id : target.identifier}"]`);
    await expect(page.locator("[data-dag-task]").first()).toBeVisible({ timeout: 20_000 });
    {
      const pane = (await page.locator(".react-flow__pane").boundingBox())!;
      await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
      const targetVisible = () => task.count();
      // Pan into a corner of the padded translate extent first (wheel pans
      // clamp at its edges), then tile the extent: narrow y bands with full
      // boustrophedon x sweeps. A single 1600px y hop can jump from "whole
      // scene visible" to "only padding visible" in very wide scenes.
      for (let i = 0; i < 20 && (await targetVisible()) === 0; i++) await page.mouse.wheel(0, 3200);
      for (let i = 0; i < 30 && (await targetVisible()) === 0; i++) await page.mouse.wheel(-3200, 0);
      for (let band = 0; band < 16 && (await targetVisible()) === 0; band++) {
        const dx = band % 2 === 0 ? 3200 : -3200;
        for (let i = 0; i < 60 && (await targetVisible()) === 0; i++) {
          await page.mouse.wheel(dx, 0);
          await page.waitForTimeout(40);
        }
        if ((await targetVisible()) === 0) await page.mouse.wheel(0, -600);
      }
    }
    await task.waitFor({ timeout: 20_000 });
    await task.dispatchEvent("click");
    await expect(page.locator("[data-dag-label]")).toContainText(target.identifier);
    if (!(await page.locator("[data-dag-enter-focus]").isVisible()))
      await page.getByRole("button", { name: "More", exact: true }).click();
    const result = await page.locator("[data-dag-enter-focus]").evaluate((button, id) => new Promise<{ elapsed_ms: number | string; max_frame_ms: number; rendered_tasks: number; fallback: boolean }>((resolve) => {
      const start = performance.now();
      let last = start, maxFrame = 0, frame = 0;
      const tick = (now: number) => { maxFrame = Math.max(maxFrame, now - last); last = now; frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      const timer = setTimeout(() => finish("timeout"), 30_000);
      const finish = (elapsed: number | string) => {
        clearTimeout(timer); observer.disconnect(); cancelAnimationFrame(frame);
        resolve({ elapsed_ms: elapsed, max_frame_ms: Math.round(maxFrame), rendered_tasks: document.querySelectorAll("[data-dag-task]").length, fallback: !!document.querySelector("[data-dag-fallback]") });
      };
      const observer = new MutationObserver(() => {
        const canvas = document.querySelector('[data-dag-level="focus"]');
        if (canvas?.getAttribute("data-dag-scene") !== id) return;
        // The wrapper's attributes can commit before React Flow updates its
        // internal node store. Require a focus fragment, not the old line.
        const fragment = [...canvas.querySelectorAll("[data-dag-frame]")].some((element) => element.getAttribute("data-dag-frame")?.startsWith('["focus-frame",'));
        if (!fragment) return;
        observer.disconnect();
        // One frame after React Flow committed the target card.
        requestAnimationFrame(() => finish(Math.round(performance.now() - start)));
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }), target.id);
    let focusPan: Awaited<ReturnType<typeof gesture>> | undefined;
    if (label === "largest") {
      const point = await page.evaluate(() => (window as unknown as { __dagPanePoint: () => { x: number; y: number } | null }).__dagPanePoint());
      focusPan = point ? await gesture("focus_largest_pan", async () => {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        const started = Date.now();
        let step = 0;
        while (Date.now() - started < 1_500) {
          await page.mouse.move(point.x + (step++ % 20) * 4, point.y + (step % 20) * 2);
          await page.waitForTimeout(16);
        }
        await page.mouse.up();
      }) : "invalid";
    }
    focusResults[label] = { ...target, ...result, pan: focusPan };
    if (result.elapsed_ms === "timeout") timedOut[`focus_${label}`] = true;
    if (process.env.PERF_SCREENSHOT_DIR) {
      mkdirSync(process.env.PERF_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(process.env.PERF_SCREENSHOT_DIR, `focus-${label}.png`) });
    }
    await page.locator("[data-dag-exit-focus]").click();
    await expect(page.locator('[data-dag-level="line"]')).toBeVisible();
  }

  // ---- 5. Collect ------------------------------------------------------------
  if (unknownRequests.length) invalid.push(`unmocked requests: ${[...new Set(unknownRequests)].slice(0, 5).join(", ")}`);
  if (external.length) invalid.push(`external requests: ${external.join(", ")}`);
  if (pageErrors.length) invalid.push(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);

  const cpus = os.cpus();
  emit({
    status: Object.keys(timedOut).length ? "timeout" : invalid.length ? "invalid" : "ok",
    invalid,
    timed_out_at: Object.keys(timedOut),
    dataset: DATASET,
    switches: switchesApplied,
    entered_line: enteredLine,
    fixture_version: ISSUE_GRAPH_FIXTURE_VERSION,
    fixture_digest: issueGraphFixtureDigest(graph),
    fixture_stats: stats,
    throttle_cpu: THROTTLE,
    machine: {
      node_version: process.version,
      browser_version: page.context().browser()?.version() ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      cpus: cpus.length,
      cpu_model: cpus[0]?.model ?? "unknown",
      memory_gb: Math.round(os.totalmem() / 1024 ** 3),
    },
    fetch_ms: fetchMs,
    fetch_body_bytes: graphBodyBytes,
    parse_ms: parseMs,
    parse_and_validate_ms: validateMs,
    layout_ms: layoutMs,
    layout_respond_ms: layoutRespondMs,
    layout_requests: layouts.length,
    load_budget_ms: LOAD_LIMIT_MS,
    first_interactive_ms: firstInteractiveMs,
    // The OL-281 budget read directly: from the graph response end to the
    // first operable frame, network fetch excluded.
    data_to_interactive_ms:
      firstInteractiveMs != null && graphTiming
        ? Math.max(0, Math.round(firstInteractiveMs - graphTiming.end))
        : null,
    pan,
    zoom,
    click: clickOutcome,
    enter_line_ms: enterLineMs,
    focus: focusResults,
    unmocked_requests: [...new Set(unknownRequests)].slice(0, 10),
    page_errors: pageErrors.slice(0, 5),
  });

  expect(Object.keys(timedOut), `timed out at: ${Object.keys(timedOut).join(", ")}`).toEqual([]);
  expect(invalid.join(" | ")).toBe("");
});
