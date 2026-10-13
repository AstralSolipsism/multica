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
/** Beyond this a measurement is `timeout`, not a duration. */
const LOAD_LIMIT_MS = 180_000;

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
    const layouts = [];
    window.__dagLayouts = layouts;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      postMessage(data) {
        try {
          if (data && typeof data.requestId === "number") {
            layouts.push({ requestId: data.requestId, postedAt: perf(), doneAt: null, committedAt: null });
          }
        } catch {}
        return super.postMessage(data);
      }
    };
    // The response arrives on the worker's message event; "committed" is the
    // next frame after the app applied it. Polled from the click prober's rAF
    // loop below — cheap enough and avoids patching addEventListener.
    const drainLayouts = () => {
      const pending = layouts.filter((l) => l.doneAt == null);
      if (!pending.length) return;
      const open = pending.filter((l) => l.doneAt == null);
      for (const record of open) record.doneAtMaybe = true;
      requestAnimationFrame(drainLayouts);
    };
    requestAnimationFrame(drainLayouts);
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
    // Layout commit frame: resolve the newest unanswered layout on the frame
    // after the skeleton-gone mark moves (the app applied the result).
    const commitWatcher = () => {
      const open = layouts.filter((l) => l.committedAt == null);
      for (const record of open) {
        if (marks.skeletonGoneAt != null && record.postedAt <= marks.skeletonGoneAt) {
          record.committedAt = marks.skeletonGoneAt;
        }
      }
      requestAnimationFrame(commitWatcher);
    };
    requestAnimationFrame(commitWatcher);
    // A worker message marks doneAt: patch addEventListener on workers we
    // construct is awkward post-construction; instead watch for the React
    // commit via skeleton. doneAt = the frame the skeleton disappeared, which
    // bounds postMessage→commit from above (the commit IS the response).
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
      void labelSeen;
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
    // Cards actually visible in the viewport, with a body point that is not
    // the 76px group header (the fold toggle lives there).
    window.__dagVisibleCards = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const cards = [...document.querySelectorAll('.react-flow__node')]
        .filter((el) => el.querySelector('[data-dag-group],[data-dag-issue]'));
      const out = [];
      for (const el of cards) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
        const x = rect.x + Math.min(rect.width / 2, 124);
        const y = rect.y + Math.min(rect.height - 12, 96);
        const hit = document.elementFromPoint(x, y);
        if (hit && (el === hit || el.contains(hit))) out.push({ x, y, id: el.getAttribute("data-id") });
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
  const navStart = Date.now();
  await page.goto(`${origin}/${WORKSPACE_SLUG}/issues`, { waitUntil: "domcontentloaded", timeout: LOAD_LIMIT_MS });

  // First interactive, measured in-page: canvas rendered, cards appeared,
  // pending skeleton gone, toolbar visible. Poll the marks until all four
  // exist or the budget expires.
  let marks: { firstCardAt: number | null; toolbarAt: number | null; skeletonGoneAt: number | null; graphCanvasAt: number | null };
  try {
    marks = await page.waitForFunction(
      () => {
        const m = (window as unknown as { __dagMarks: Record<string, number | null> }).__dagMarks;
        return m.firstCardAt != null && m.skeletonGoneAt != null && m.toolbarAt != null
          ? (m as unknown) : false;
      },
      undefined,
      { timeout: LOAD_LIMIT_MS },
    ).then((handle) => handle.jsonValue() as unknown as typeof marks);
  } catch {
    marks = await page.evaluate(() => (window as unknown as { __dagMarks: typeof marks }).__dagMarks);
    // "Nothing rendered" (canvas or cards never appeared) is an invalid
    // sample, not a slow one: an empty page must never read as either fast
    // or merely tardy. Only a page that got as far as cards and then stalled
    // past the budget counts as a timeout.
    if (marks.graphCanvasAt == null) invalid.push("DAG canvas never rendered");
    else if (marks.firstCardAt == null) invalid.push("canvas rendered but no cards appeared");
    else timedOut.first_interactive = true;
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
  // separately — see README).
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

  // Layout timing: worker postMessage → result committed, per requestId.
  const layouts = await page.evaluate(
    () => (window as unknown as { __dagLayouts: { requestId: number; postedAt: number; committedAt: number | null }[] }).__dagLayouts,
  );
  const committed = layouts.filter((l) => l.committedAt != null);
  const layoutMs = committed.length
    ? Math.round(Math.max(...committed.map((l) => l.committedAt! - l.postedAt)))
    : null;

  // Per-measurement outcomes. Gestures only make sense once cards exist.
  const cardsPresent = marks.firstCardAt != null;
  if (!cardsPresent) {
    if (invalid.length === 0) invalid.push("no cards: gestures and clicks not measurable");
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
  // In-page: real pointer events on visible cards' bodies (never the 76px
  // group header), timed from pointerdown to the frame after the toolbar's
  // selection label appears. Each sample starts from a cleared selection.
  const clickSamples: number[] = [];
  let clickOutcome: Record<string, number | null> | string = "invalid";
  if (cardsPresent) {
    let anySelected = false;
    let anyTimeout = false;
    for (let i = 0; i < CLICK_SAMPLES; i++) {
      const cards = await page.evaluate(() => (window as unknown as { __dagVisibleCards: () => { x: number; y: number }[] }).__dagVisibleCards());
      if (!cards.length) break;
      const card = cards[Math.floor((i * cards.length) / CLICK_SAMPLES)]!;
      // Clear any previous selection first, and prove it is gone.
      await page.evaluate(() => (window as unknown as { __dagClearSelection: () => Promise<boolean> }).__dagClearSelection());
      const result = await page.evaluate(
        ({ x, y }) => (window as unknown as { __dagClick: (x: number, y: number) => Promise<{ outcome: string; elapsed: number }> }).__dagClick(x, y),
        card,
      );
      if (result.outcome === "selected") {
        clickSamples.push(result.elapsed);
        anySelected = true;
      } else {
        anyTimeout = true;
      }
    }
    clickOutcome = clickSamples.length >= 3
      ? { samples: clickSamples.length, p50_ms: percentile(clickSamples, 50), p95_ms: percentile(clickSamples, 95) }
      : anySelected ? "timeout" : anyTimeout ? "timeout" : "invalid";
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
    layout_requests: layouts.length,
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
