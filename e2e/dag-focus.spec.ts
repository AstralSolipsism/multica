import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockDagGraph, WORKSPACE_SLUG } from "./dag-graph-fixture";
import { buildIssueGraphFixture, ISSUE_GRAPH_FIXTURE_DATASETS, type SyntheticGraphNode, type SyntheticIssueGraph } from "@multica/core/issues/testing/issue-graph-fixture";
import { createDagModelIndex } from "@multica/core/issues/dag/model-index";
import { IssueGraphSchema } from "@multica/core/api";

test.use({ viewport: { width: 1600, height: 1050 }, locale: "en-US", colorScheme: "light", serviceWorkers: "block" });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(): SyntheticIssueGraph {
  const base = buildIssueGraphFixture(ISSUE_GRAPH_FIXTURE_DATASETS["1000"]);
  const node = (n: number, title: string, parent: number | null = null, done = false): SyntheticGraphNode => ({
    ...base.nodes[0]!, id: id(n), identifier: `FOCUS-${n}`, title,
    parent_issue_id: parent === null ? null : id(parent), project_id: null,
    status: done ? "done" : "todo", status_category: done ? "done" : "unstarted",
    stage: null, run_summary: null,
    dependency_summary: { visible_unsatisfied_count: n === 4 ? 1 : 0, has_restricted_blockers: false, dependency_version: "fixture" },
  });
  return {
    ...base, nodes: [node(1, "Design"), node(2, "Implement", 1), node(3, "Delivery"), node(4, "Verify", 3), node(5, "Completed prerequisite", null, true)],
    edges: [[5, 2], [2, 4]].map(([source, target]) => ({ source: id(source!), target: id(target!), source_edge_id: id(source! * 10 + target!), type: "blocked_by" })),
    projects: [], matched_count: 5, context_count: 0,
  };
}

async function enterFocus(page: Page, issueId: string) {
  await page.locator(`.react-flow__node[data-id="${issueId}"] [data-dag-task]`).click();
  const button = page.locator("[data-dag-enter-focus]");
  if (!(await button.isVisible())) await page.getByRole("button", { name: "More", exact: true }).click();
  await button.click();
  await expect(page.locator('[data-dag-level="focus"]')).toHaveAttribute("data-dag-scene", issueId);
  await expect(page.locator(`.react-flow__node[data-id="${issueId}"] [data-dag-task]`)).toBeVisible();
}

const viewport = (page: Page) => page.locator(".react-flow__viewport").evaluate((element) => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, zoom: matrix.a };
});

async function expectCenteredSeed(page: Page, identifier: string) {
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThanOrEqual(0.85);
  await expect.poll(async () => {
    const canvas = (await page.locator("[data-dag-canvas]").boundingBox())!;
    const seed = (await page.locator(`[data-dag-task="${identifier}"]`).boundingBox())!;
    return Math.max(Math.abs(seed.x + seed.width / 2 - canvas.x - canvas.width / 2), Math.abs(seed.y + seed.height / 2 - canvas.y - canvas.height / 2));
  }).toBeLessThan(2);
}

test("focus mode traces cross-line dependencies, survives reload and restores the entry viewport", async ({ page, context, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const network = await mockDagGraph(context, new URL(baseURL!).origin, fixture(), { preferences: { dagLineId: id(1) } });
  await page.goto(`/${WORKSPACE_SLUG}/issues`);
  await expect(page.locator('[data-dag-task="FOCUS-2"]')).toBeVisible({ timeout: 20_000 });
  const before = await viewport(page);
  await enterFocus(page, id(2));
  await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText("Focus FOCUS-2");
  await expect(page.locator('[data-dag-task="FOCUS-4"]')).toBeAttached();
  // Design contains only the current task; inheriting its ancestors must not
  // create an empty duplicate Design frame in the upstream column.
  await expect(page.locator("[data-dag-frame]")).toHaveCount(2);
  await expect(page.locator('[data-dag-task="FOCUS-5"]')).toHaveCount(0);
  await expect(page.locator("[data-dag-focus-hidden]")).toContainText("1");
  await expectCenteredSeed(page, "FOCUS-2");
  await page.locator("[data-dag-focus-hidden] button").click();
  await expect(page.locator('[data-dag-task="FOCUS-5"]')).toBeAttached();
  await testInfo.attach("focus-cross-lines", { body: await page.screenshot(), contentType: "image/png" });
  await page.reload();
  await expect(page.locator('[data-dag-level="focus"]')).toHaveAttribute("data-dag-scene", id(2));
  await page.locator("[data-dag-exit-focus]").click();
  await expect(page.locator('[data-dag-level="line"]')).toHaveAttribute("data-dag-scene", id(1));
  await expect.poll(() => viewport(page)).toEqual(before);
  expect(errors).toEqual([]);
  expect(network.unknownRequests).toEqual([]);
  expect(network.external).toEqual([]);
});

// Optional read-only CLI snapshot rendering, kept outside Git. It exercises
// the same frontend and entry action as the synthetic regression above.
test("render an authorized workspace snapshot in focus mode", async ({ page, context, baseURL }, testInfo) => {
  test.skip(!process.env.DAG_SNAPSHOT_PATH, "Set DAG_SNAPSHOT_PATH to a CLI-reconstructed schema-v1 graph");
  const graph: SyntheticIssueGraph = JSON.parse(readFileSync(process.env.DAG_SNAPSHOT_PATH!, "utf8"));
  const index = createDagModelIndex(IssueGraphSchema.parse(graph));
  const seed = [...index.issues.values()].find((issue) => issue.identifier === process.env.DAG_FOCUS_IDENTIFIER)!;
  expect(seed).toBeDefined();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockDagGraph(context, new URL(baseURL!).origin, graph, { locale: "zh-Hans", workspaceName: "Labrastro · 只读快照", preferences: { dagLineId: index.rootOf.get(seed.id), dagShowCompleted: true } });
  await page.goto(`/${WORKSPACE_SLUG}/issues`);
  await page.locator(`[data-dag-task="${seed.identifier}"]`).waitFor();
  await page.screenshot({ path: testInfo.outputPath("workspace-before.png") });
  await page.locator(`[data-dag-task="${seed.identifier}"]`).dispatchEvent("click");
  if (!(await page.locator("[data-dag-enter-focus]").isVisible())) await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.locator("[data-dag-enter-focus]").click();
  await expect(page.locator('[data-dag-level="focus"]')).toHaveAttribute("data-dag-scene", seed.id);
  await expect(page.locator(`[data-dag-task="${seed.identifier}"]`)).toBeVisible();
  await expectCenteredSeed(page, seed.identifier);
  await page.screenshot({ path: testInfo.outputPath("workspace-focus-detail.png") });
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("workspace-focus.png") });
  expect(errors).toEqual([]);
});
