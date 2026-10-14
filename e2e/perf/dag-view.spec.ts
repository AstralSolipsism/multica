/**
 * DAG view performance scenario (OL-278).
 *
 * Measures the issues page's DAG view against synthetic graph data of the
 * shapes OL-183 defined: fetch, parse+validate, layout, first-interactive,
 * pan/zoom frame rate, and card-click response. Everything except HTTP is the
 * real production page — routing, TanStack Query, the ELK layout worker,
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

const WORKSPACE_SLUG = "perf";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const workspace = {
  id: WORKSPACE_ID, name: "Perf", slug: WORKSPACE_SLUG,
  description: null, context: null,
  settings: { github_enabled: false }, repos: [],
  issue_prefix: "GAME", avatar_url: null,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

const me = {
  id: USER_ID, name: "Perf User", email: "perf@example.test", avatar_url: null,
  language: null, onboarded_at: "2026-09-01T00:00:00Z",
  onboarding_questionnaire: { source: "other" },
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

/** Built-in status catalog so cards resolve colours and categories. */
const statuses = [
  { key: "backlog", name: "Backlog", category: "unstarted", color: "#94a3b8" },
  { key: "todo", name: "Todo", category: "unstarted", color: "#64748b" },
  { key: "in_progress", name: "In Progress", category: "started", color: "#3b82f6" },
  { key: "in_review", name: "In Review", category: "started", color: "#8b5cf6" },
  { key: "blocked", name: "Blocked", category: "started", color: "#f59e0b" },
  { key: "done", name: "Done", category: "done", color: "#22c55e" },
  { key: "cancelled", name: "Cancelled", category: "closed", color: "#ef4444" },
].map((status, index) => ({
  ...status,
  id: `s-${status.key}`,
  workspace_id: WORKSPACE_ID,
  description: "",
  icon: null,
  is_system: true,
  position: index,
  archived_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
}));

/** Detail shape for a graph node, for the toolbar's selection fetch. */
const issueDetail = (node: { id: string; identifier: string; title: string; status: string; priority: string }) => ({
  id: node.id, workspace_id: WORKSPACE_ID, number: 1,
  identifier: node.identifier, title: node.title,
  description: "Synthetic.", status: node.status,
  status_category: node.status, status_name: node.status, priority: node.priority,
  assignee_type: null, assignee_id: null, creator_type: "user", creator_id: USER_ID,
  parent_issue_id: null, project_id: null, position: 0,
  start_date: null, due_date: null, stage: null, metadata: {}, properties: {},
  labels: [], reactions: [],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
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
 * Injected before the app boots. Owns three measurements:
 *  - rAF frame-interval sampling (`__dagSample`);
 *  - layout-worker timing: Worker#postMessage → message received, keyed by
 *    the requestId the DAG layout protocol carries (`__dagLayouts`);
 *  - first-occurrence markers via MutationObserver for cards, toolbar and
 *    the pending-skeleton disappearing (`__dagMarks`), all on
 *    performance.now();
 *  - an in-page click prober that dispatches a real pointer click and waits
 *    for the toolbar selection label to appear, then resolves on the next
 *    animation frame (`__dagClick`).
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
    // Each request is timed postMessage → response (message event, recorded
    // in the constructor so every worker instance is covered) → committed
    // (the frame the pending skeleton disappeared, i.e. the React commit of
    // the result). A response carrying 'error' is recorded as such.
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
            layouts.push({ requestId: data.requestId, postedAt: perf(), respondedAt: null, error: null, committedAt: null });
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
      if (marks.firstCardAt == null && has('[data-dag-group],[data-dag-issue]')) marks.firstCardAt = perf();
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
    // applying the result (use-dag-layout sets pendingSince null on receipt
    // and React commits on the next render pass).
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
    // Candidate points avoid the 76px group header (the fold toggle button
    // lives there): centre-low first, then progressively lower/left-right
    // offsets. A point is rejected when it is outside the card or lands on a
    // button, so "never click the header" holds at any zoom level.
    window.__dagVisibleCards = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const cards = [...document.querySelectorAll('.react-flow__node')]
        .filter((el) => el.querySelector('[data-dag-group],[data-dag-issue]'));
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
  const details = new Map(graph.nodes.map((n) => [n.id, issueDetail(n)]));
  const unknownRequests: string[] = [];
  const pageErrors: string[] = [];
  const external: string[] = [];
  let graphBodyBytes = 0;

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await context.addCookies([
    { name: "multica_logged_in", value: "1", url: origin },
    { name: "last_workspace_slug", value: WORKSPACE_SLUG, url: origin },
  ]);
  await context.addInitScript(() => {
    window.localStorage.setItem("multica:chat:floatingChatEnabled", "false");
  });
  // Preselect the DAG view for this workspace so navigation lands on the graph
  // immediately; the surface registry persists per workspace slug.
  await context.addInitScript((slug) => {
    window.localStorage.setItem(
      `multica_issue_surface_views:${slug}`,
      JSON.stringify({
        state: {
          surfaces: {
            "workspace:all": { state: { viewMode: "dag" }, updatedAt: "2026-09-01T00:00:00.000Z" },
          },
        },
        version: 1,
      }),
    );
  }, WORKSPACE_SLUG);
  await context.addInitScript(INSTRUMENT);

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === `/api/workspaces/${WORKSPACE_ID}/issues/graph`) {
      graphBodyBytes = Buffer.byteLength(graphJson);
      return route.fulfill({ status: 200, contentType: "application/json", body: graphJson });
    }
    const detail = /^\/api\/issues\/([0-9a-f-]+)$/.exec(url.pathname);
    if (detail && details.has(detail[1]!)) return route.fulfill(json(details.get(detail[1]!)));
    switch (url.pathname) {
      case "/api/config": return route.fulfill(json({ feature_flags: {}, allow_signup: true }));
      case "/api/me": return route.fulfill(json(me));
      case "/api/workspaces": return route.fulfill(json([workspace]));
      case "/api/client-usage": return route.fulfill(json({}));
      case "/api/agents": case "/api/runtimes": case "/api/squads":
      case "/api/agent-task-snapshot": case "/api/invitations": case "/api/inbox":
      case "/api/inbox/unread-summary": case "/api/pins": case "/api/chat/sessions":
      case `/api/workspaces/${WORKSPACE_ID}/members`:
        return route.fulfill(json([]));
      case "/api/projects": return route.fulfill(json({ projects: [], total: 0 }));
      case "/api/issues": return route.fulfill(json({ issues: [], total: 0 }));
      // The issues surface also queries table rows/facets and saved views;
      // empty answers keep them off the DAG's critical path without 404 noise.
      case "/api/issues/table/rows":
      case "/api/issues/table/facets":
        return route.fulfill(json({ rows: [], total: 0, groups: [], facets: {} }));
      case "/api/issue-views": return route.fulfill(json({ views: [], total: 0 }));
      case "/api/issue-view-preferences":
      case "/api/notification-preferences":
        return route.fulfill(json({}));
      case "/api/issue-wakeup-summaries": return route.fulfill(json({ summaries: [] }));
      case "/api/search-index/manifest": return route.fulfill(json({}));
      case "/api/issue-statuses":
        return route.fulfill(json({ statuses, categories: ["unstarted", "started", "done", "closed"], total: statuses.length }));
      case "/api/properties": return route.fulfill(json({ properties: [], total: 0 }));
      case "/api/quick-actions": return route.fulfill(json({ quick_actions: [] }));
      case "/api/assignee-frequency": return route.fulfill(json([]));
      case "/api/issues/child-progress": return route.fulfill(json({ progress: [] }));
      default:
        unknownRequests.push(`${route.request().method()} ${url.pathname}`);
        return route.fulfill(json({}));
    }
  });
  // A stubbed socket keeps the realtime layer out of the numbers; the canvas
  // DOM proves liveness.
  await context.routeWebSocket((url) => url.pathname === "/ws", (ws) => {
    ws.onMessage(() => {});
  });

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
    layouts: (window as unknown as { __dagLayouts: { requestId: number; postedAt: number; respondedAt: number | null; error: string | null; committedAt: number | null }[] }).__dagLayouts,
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
  // In-page: real pointer events on visible cards' bodies (never the 76px
  // group header), timed from pointerdown to the frame after the toolbar's
  // selection label appears. Each sample starts from a cleared selection.
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

  // ---- 4. Collect ------------------------------------------------------------
  if (unknownRequests.length) invalid.push(`unmocked requests: ${[...new Set(unknownRequests)].slice(0, 5).join(", ")}`);
  if (external.length) invalid.push(`external requests: ${external.join(", ")}`);
  if (pageErrors.length) invalid.push(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);

  const cpus = os.cpus();
  emit({
    status: Object.keys(timedOut).length ? "timeout" : invalid.length ? "invalid" : "ok",
    invalid,
    timed_out_at: Object.keys(timedOut),
    dataset: DATASET,
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
    pan,
    zoom,
    click: clickOutcome,
    unmocked_requests: [...new Set(unknownRequests)].slice(0, 10),
    page_errors: pageErrors.slice(0, 5),
  });

  expect(Object.keys(timedOut), `timed out at: ${Object.keys(timedOut).join(", ")}`).toEqual([]);
  expect(invalid.join(" | ")).toBe("");
});
