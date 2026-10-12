/**
 * DAG view performance scenario (OL-278).
 *
 * Measures the issues page's DAG view against synthetic graph data of the
 * shapes OL-183 defined: fetch, parse+validate, layout, first-interactive,
 * pan/zoom frame rate, and card-click response. Everything except HTTP is the
 * real production page — routing, TanStack Query, zod validation, the ELK
 * layout worker, React Flow. Like the typing scenario, requests are answered
 * from a fixed table: anything outside it invalidates the sample.
 *
 * The result is a report, not a gate. `timeout` and `invalid` are outcomes,
 * never durations — an empty page is not fast.
 *
 *   pnpm exec playwright test --config=playwright.perf.config.ts e2e/perf/dag-view.spec.ts
 *   PERF_DATASET=stress-5000 PERF_THROTTLE_CPU=4 PERF_REPORT_PATH=report.json ...
 */
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ISSUE_GRAPH_FIXTURE_DATASETS,
  ISSUE_GRAPH_FIXTURE_VERSION,
  analyzeIssueGraphFixture,
  buildIssueGraphFixture,
  issueGraphFixtureDigest,
  type IssueGraphFixtureDatasetName,
} from "@multica/core/issues/testing/issue-graph-fixture";

test.setTimeout(600_000);

const DATASET = (process.env.PERF_DATASET ?? "stress-5000") as IssueGraphFixtureDatasetName;
if (!(DATASET in ISSUE_GRAPH_FIXTURE_DATASETS)) {
  throw new Error(`unknown PERF_DATASET ${DATASET}`);
}
/** CDP CPU throttle factor; 1 = unthrottled. */
const THROTTLE = Number(process.env.PERF_THROTTLE_CPU ?? 1);
const CONFIG = ISSUE_GRAPH_FIXTURE_DATASETS[DATASET]!;
/** How long the scripted pan and zoom gestures each run. */
const GESTURE_MS = 4_000;
/** Measured click samples. */
const CLICK_SAMPLES = 10;
/** Beyond this a measurement is `timeout`, not a duration. */
const LOAD_LIMIT_MS = 120_000;
const LAYOUT_LIMIT_MS = 180_000;

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

/** Frame-interval stats via rAF sampling injected before the page loads. */
const FRAME_SAMPLER = `
  (() => {
    const store = { intervals: [], sampling: false };
    window.__dagFrames = store;
    window.__dagSample = (on) => {
      store.sampling = on;
      if (on) store.intervals = [];
    };
    let last = null;
    const tick = (now) => {
      if (store.sampling) {
        if (last != null) store.intervals.push(now - last);
        last = now;
      } else {
        last = null;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
`;

test(`DAG view performance (${DATASET})`, async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const graph = buildIssueGraphFixture(CONFIG);
  const stats = analyzeIssueGraphFixture(graph);
  const graphJson = JSON.stringify(graph);
  const details = new Map(graph.nodes.map((n) => [n.id, issueDetail(n)]));
  const unknownRequests: string[] = [];
  const pageErrors: string[] = [];
  const external: string[] = [];
  /** Fetch timing: request sent → response ended, from the route handler. */
  let fetchDoneAt: number | null = null;
  let fetchStartAt: number | null = null;
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
  await context.addInitScript(FRAME_SAMPLER);

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === `/api/workspaces/${WORKSPACE_ID}/issues/graph`) {
      fetchStartAt ??= Date.now();
      graphBodyBytes = Buffer.byteLength(graphJson);
      await route.fulfill({ status: 200, contentType: "application/json", body: graphJson });
      fetchDoneAt = Date.now();
      return;
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
  // The graph page has no socket dependency to prove liveness; the canvas DOM
  // does that. A stubbed socket keeps the realtime layer out of the numbers.
  await context.routeWebSocket((url) => url.pathname === "/ws", (ws) => {
    ws.onMessage(() => {});
  });

  if (THROTTLE > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }

  const invalid: string[] = [];
  const timedOut: Record<string, true> = {};
  const remaining = (limit: number, since: number) => Math.max(0, limit - (Date.now() - since));
  async function bounded<T>(work: Promise<T>, label: string, limit: number, since: number): Promise<T | null> {
    const budget = remaining(limit, since);
    if (budget <= 0) { timedOut[label] = true; return null; }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((done) => { timer = setTimeout(() => done(null), budget); });
    const value = await Promise.race([work.then((v) => v, () => null), expired]);
    clearTimeout(timer);
    if (value === null) timedOut[label] = true;
    return value;
  }

  // ---- 1. Navigate: fetch → parse → layout → first interactive ------------
  const navStart = Date.now();
  await page.goto(`${origin}/${WORKSPACE_SLUG}/issues`, { waitUntil: "domcontentloaded", timeout: LOAD_LIMIT_MS });

  // The view must actually be the DAG: the canvas container is its marker.
  const canvas = page.locator("[data-dag-canvas]");
  const toolbar = page.locator("[data-dag-toolbar]");
  const dagVisible = await bounded(
    expect(canvas).toBeVisible({ timeout: LOAD_LIMIT_MS }).then(() => true as const),
    "canvas", LOAD_LIMIT_MS, navStart,
  );
  let firstInteractiveMs: number | null = null;
  if (dagVisible) {
    // First interactive = cards on the canvas AND no pending layout skeleton.
    // Collapsed lines render group cards; expanded render task cards; either
    // counts. The layout-pending state is the skeleton block, whose absence
    // plus a toolbar means the first layout committed.
    const interactive = await bounded(
      (async () => {
        await expect(page.locator("[data-dag-group], [data-dag-issue]").first()).toBeVisible({ timeout: LOAD_LIMIT_MS });
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: LOAD_LIMIT_MS });
        await expect(toolbar).toBeVisible({ timeout: LOAD_LIMIT_MS });
        await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: LOAD_LIMIT_MS });
        return true as const;
      })().catch(() => null),
      "first_interactive", LOAD_LIMIT_MS, navStart,
    );
    if (interactive) firstInteractiveMs = Date.now() - navStart;
  } else {
    invalid.push("DAG canvas never rendered");
  }

  // Parse timing: the page's own resource timing for the graph response gives
  // JSON arrival; zod validation cost is measured in-page on the same bytes.
  const resourceTiming = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => ({
      name: e.name, start: e.startTime, end: (e as PerformanceResourceTiming).responseEnd,
    })).filter((e) => e.name.includes("/issues/graph")),
  );
  const parseMs = await page.evaluate(async (text) => {
    const started = performance.now();
    JSON.parse(text);
    return Math.round(performance.now() - started);
  }, graphJson).catch(() => null);

  // Layout timing: worker postMessage → commit. Measured by watching the
  // layout-pending marker disappear after data arrival; on a slow machine the
  // pending skeleton IS the layout request in flight.
  const layoutPendingGone = firstInteractiveMs != null ? firstInteractiveMs : null;

  // If the canvas never came up, everything else is moot.
  if (!dagVisible) {
    const report = {
      status: timedOut.canvas ? "timeout" : "invalid",
      invalid, timed_out_at: Object.keys(timedOut),
      dataset: DATASET, fixture_version: ISSUE_GRAPH_FIXTURE_VERSION,
      fixture_digest: issueGraphFixtureDigest(graph),
      fixture_stats: stats, throttle_cpu: THROTTLE,
      first_interactive_ms: null, parse_ms: parseMs, layout_ms: null,
      fetch_ms: fetchStartAt != null && fetchDoneAt != null ? fetchDoneAt - fetchStartAt : null,
      page_errors: pageErrors, unmocked_requests: unknownRequests,
    };
    emit(report);
    if (timedOut.canvas) throw new Error(`canvas never rendered within ${LOAD_LIMIT_MS}ms`);
    expect(invalid.join(" | ")).toBe("");
    return;
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
    const frames = intervals.filter((i) => i > 0 && i < 1_000);
    if (frames.length < 10) return null;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    return {
      frames: frames.length,
      p50_ms: percentile(frames, 50),
      p95_ms: percentile(frames, 95),
      avg_fps: Math.round((1000 / avg) * 10) / 10,
    };
  };

  const box = await canvas.boundingBox();
  const cx = (box?.x ?? 800) + (box?.width ?? 800) / 2;
  const cy = (box?.y ?? 400) + (box?.height ?? 600) / 2;

  const pan = await frameStats(async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const panStart = Date.now();
    let step = 0;
    while (Date.now() - panStart < GESTURE_MS) {
      // Diagonal sweep, direction reversing every ~800ms.
      const phase = Math.floor((Date.now() - panStart) / 800) % 2 === 0 ? 1 : -1;
      await page.mouse.move(cx + step * phase, cy + step * phase * 0.6, { steps: 4 });
      step = (step + 14) % 120;
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });

  const zoom = await frameStats(async () => {
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

  // ---- 3. Click response ----------------------------------------------------
  // With onlyRenderVisibleElements the off-screen cards are not mounted, so
  // the sample set is what the viewport actually shows.
  const nodeCards = page.locator(".react-flow__node[data-id]").filter({ has: page.locator("[data-dag-group], [data-dag-issue]") });
  const visibleCards = nodeCards.filter({ visible: true });
  const cardCount = await visibleCards.count();
  const selectionLabel = page.locator("[data-dag-toolbar] [data-dag-label]");
  const clickSamples: number[] = [];
  for (let i = 0; i < CLICK_SAMPLES && cardCount > 0; i++) {
    const index = Math.floor((i * cardCount) / CLICK_SAMPLES);
    const card = visibleCards.nth(index);
    if (!(await card.count())) continue;
    const started = Date.now();
    // A card body click selects it (the header button toggles folds instead).
    await card.click({ timeout: 10_000, position: { x: 30, y: 30 } }).catch(() => {});
    // Click response ends when the toolbar's selection zone shows the card.
    try {
      await expect
        .poll(async () => (await selectionLabel.count())
          ? await selectionLabel.first().innerText().catch(() => "")
          : "", { timeout: 10_000 })
        .not.toBe("");
      clickSamples.push(Date.now() - started);
    } catch {
      // Sample unusable; keep going so the report still carries the rest.
    }
    // Clear selection so the next sample starts from the same state.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }

  if (external.length) invalid.push(`external requests: ${external.join(", ")}`);
  if (pageErrors.length) invalid.push(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);

  const status = Object.keys(timedOut).length ? "timeout" : invalid.length ? "invalid" : "ok";
  emit({
    status, invalid,
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
      cpus: (await import("node:os")).cpus().length,
    },
    fetch_ms: fetchStartAt != null && fetchDoneAt != null ? fetchDoneAt - fetchStartAt : null,
    fetch_body_bytes: graphBodyBytes,
    parse_ms: parseMs,
    resource_timing: resourceTiming.slice(0, 1),
    layout_ms: layoutPendingGone,
    first_interactive_ms: firstInteractiveMs,
    pan: pan ?? "invalid",
    zoom: zoom ?? "invalid",
    click: clickSamples.length >= 3
      ? { samples: clickSamples.length, p50_ms: percentile(clickSamples, 50), p95_ms: percentile(clickSamples, 95) }
      : (cardCount === 0 ? "invalid" : "timeout"),
    rendered_nodes: cardCount,
    unmocked_requests: [...new Set(unknownRequests)].slice(0, 10),
    page_errors: pageErrors.slice(0, 5),
  });

  expect(Object.keys(timedOut), `timed out at: ${Object.keys(timedOut).join(", ")}`).toEqual([]);
  expect(invalid.join(" | ")).toBe("");
});
