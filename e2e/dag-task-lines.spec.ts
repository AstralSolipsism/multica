import { test, expect, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1050 } });

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;

// Real application + real isolated backend. No agents/runtimes are created or
// assigned. TestApiClient owns the ephemeral issue setup and cleanup.
async function bootGraph(page: Page, api: TestApiClient, workspace: { id: string; slug: string }, baseURL: string) {
  const token = api.getToken()!;
  await page.context().addCookies([{ name: "multica-locale", value: "en", url: baseURL }]);
  await page.addInitScript((value) => localStorage.setItem("multica_token", value), token);
  await page.goto(`/${workspace.slug}/issues`, { waitUntil: "domcontentloaded" });
  const mode = page.getByRole("button", { name: /^(Board|List|Table|Graph)$/ }).first();
  await expect(mode).toBeVisible({ timeout: 30_000 });
  if ((await mode.innerText()).trim() !== "Graph") {
    await mode.click();
    await page.getByText("Graph", { exact: true }).last().click();
  }
  // Warm the dev server's on-demand compile of the issue detail route: the
  // first soft navigation commits its URL only after the route compiles,
  // which can outlast the navigation assertion on a cold server.
  await page.evaluate(
    (slug) => fetch(`/${slug}/issues/__warm__`, { credentials: "same-origin" }).catch(() => undefined),
    workspace.slug,
  );
}

async function setBlockedBy(api: TestApiClient, workspaceId: string, id: string, blockedBy: string[]) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${api.getToken()}`,
    "X-Workspace-ID": workspaceId,
  };
  const before = await fetch(`${API_BASE}/api/issues/${id}/dependencies`, { headers });
  expect(before.ok, `${before.status} ${await before.clone().text()}`).toBe(true);
  const body = await before.json();
  const write = await fetch(`${API_BASE}/api/issues/${id}/with-dependencies`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      blocked_by: blockedBy,
      expected_dependency_version: body.dependency_version,
    }),
  });
  expect(write.ok, await write.text()).toBe(true);
}

/** React Flow only honors a dblclick on an already-selected node: select
 *  first, wait for the selection to commit, then double-click. */
async function selectThenDblclick(page: Page, target: ReturnType<Page["locator"]>) {
  await target.click();
  await expect(page.getByRole("region", { name: "Selection" })).not.toContainText(
    "Select a task or task line",
  );
  await target.dblclick();
}

const readViewport = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });

test("DAG two-level view: overview cards, line navigation, bundles and persistence", async ({
  page,
  baseURL,
}, testInfo) => {
  // Cold dev servers compile the issues page (~80s) and the detail route
  // (~35s) inside the first interactions; the budget must absorb that once.
  test.setTimeout(240_000);
  const api = new TestApiClient();
  const stamp = `${Date.now()}`;
  let workspace: { id: string; slug: string } | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.login(`dag-two-${stamp}@localhost`, "DAG Two-Level");
    workspace = await api.ensureWorkspace(`DAG Two-Level ${stamp}`, `dag-two-${stamp}`);
    await api.markUserOnboarded();
    const lineA = await api.createIssue("DAG regression: design and implementation");
    const a = await api.createIssue("DAG regression: agreed design", {
      parent_issue_id: lineA.id,
      stage: 1,
      status: "done",
    });
    const b = await api.createIssue("DAG regression: implementation", {
      parent_issue_id: lineA.id,
      stage: 2,
    });
    const lineB = await api.createIssue("DAG regression: validation and delivery");
    const c = await api.createIssue("DAG regression: verification", {
      parent_issue_id: lineB.id,
      stage: 1,
    });
    const d = await api.createIssue("DAG regression: delivery", {
      parent_issue_id: lineB.id,
      stage: 2,
    });
    const solo = await api.createIssue("DAG regression: independent note");
    for (const issue of [lineA, a, b, lineB, c, d, solo]) expect(issue.id).toBeTruthy();
    await setBlockedBy(api, workspace.id, b.id, [a.id]);
    await setBlockedBy(api, workspace.id, c.id, [a.id, b.id]);
    await setBlockedBy(api, workspace.id, d.id, [c.id]);

    await bootGraph(page, api, workspace, baseURL!);
    // Overview: two line cards plus the independent group.
    const cards = page.locator("[data-dag-overview-card]");
    await expect(cards).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator("[data-dag-overview-card][data-dag-kind='line']")).toHaveCount(2);
    await expect(
      page.locator("[data-dag-overview-card][data-dag-kind='independent']"),
    ).toHaveCount(1);
    const cardA = page.locator(`[data-dag-overview-card="issue:${lineA.id}"]`);
    await expect(cardA).toContainText("design and implementation");
    await expect(cardA).toContainText("1/2 completed");
    // The toolbar is one row and the breadcrumb roots at the overview.
    const toolbarHeight = async () =>
      (await page.locator("[data-dag-toolbar]").boundingBox())!.height;
    expect(await toolbarHeight()).toBe(40);
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "All task lines",
    );
    // a→c is satisfied (a is done), b→c still blocks: without the switch the
    // bundle carries no count badge; with it, the badge counts both.
    const layer = page.locator("[data-dag-edge-layer]");
    await expect(layer.locator("text")).toHaveCount(0);
    await page.getByRole("button", { name: "Show satisfied dependencies", exact: true }).click();
    await expect(layer.locator("text")).toHaveText("2");
    await testInfo.attach("dag-overview", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Pan away from the default so the later restore is meaningful.
    const panArea = (await page.locator("[data-dag-canvas]").boundingBox())!;
    await page.mouse.move(panArea.x + panArea.width / 2, panArea.y + panArea.height / 2);
    const beforePan = await readViewport(page);
    await page.mouse.wheel(64, 72);
    await expect.poll(async () => (await readViewport(page)).x).not.toBe(beforePan.x);
    const overviewViewport = await readViewport(page);

    // Double-click enters the line: tasks, stage columns and the side card.
    // Select first — a dblclick on an unselected node races the selection
    // render (same pattern as the previous canvas spec).
    await selectThenDblclick(page, cardA);
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "design and implementation",
    );
    await expect(page.getByRole("button", { name: "Back to overview" })).toBeVisible();
    await expect(page.locator("[data-dag-task]")).toHaveCount(2);
    await expect(page.locator("[data-dag-stage]")).toHaveCount(2);
    // The finished task fades; the open one does not.
    const taskA = page.locator(`.react-flow__node[data-id="${a.id}"]`);
    const taskB = page.locator(`.react-flow__node[data-id="${b.id}"]`);
    await expect(taskA).toContainText("agreed design");
    expect(
      await taskA.locator("[data-dag-task]").evaluate((el) => getComputedStyle(el).opacity),
    ).not.toBe("1");
    expect(
      await taskB.locator("[data-dag-task]").evaluate((el) => getComputedStyle(el).opacity),
    ).toBe("1");
    expect(await toolbarHeight()).toBe(40);
    await testInfo.attach("dag-line", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // The downstream side card compresses both dependencies on line B.
    const external = page.locator(`[data-dag-external="${lineB.id}"]`);
    await expect(external).toContainText("2 dependencies");
    await external.click();
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "validation and delivery",
    );
    await expect(page.locator("[data-dag-task]")).toHaveCount(2);
    await expect(
      page.locator(`[data-dag-external="${lineA.id}"]`),
    ).toContainText("2 dependencies");

    // Task selection keeps the OL-182 action zone; the bar stays one row.
    const taskC = page.locator(`.react-flow__node[data-id="${c.id}"]`);
    await taskC.click();
    const selection = page.getByRole("region", { name: "Selection" });
    await expect(selection.getByRole("button", { name: "Open detail" })).toBeVisible();
    expect(await toolbarHeight()).toBe(40);
    // Highlight prerequisites (via More if the width collapsed it): only the
    // chain keeps full strength.
    const focusButton = selection.getByRole("button", { name: "Highlight prerequisites", exact: true });
    if (await focusButton.count()) {
      await focusButton.click();
    } else {
      await selection.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Highlight prerequisites" }).click();
    }
    await expect(page.locator("[data-dag-edge-layer] > g").first()).toHaveClass(/opacity-15/);
    const focusAgain = selection.getByRole("button", { name: "Highlight prerequisites", exact: true });
    if (await focusAgain.count()) await focusAgain.click();
    // Escape clears the selection when the canvas node holds focus.
    await taskC.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-dag-selected]")).toHaveCount(0);
    await expect(selection).toContainText("Select a task or task line");

    // The click cycle: select with the one-layer neighborhood; a second
    // single click past the double-click window switches to all upstream +
    // downstream; a third returns. The selection zone names the scope.
    const scopeTag = selection.locator("[data-dag-scope]");
    await taskC.click();
    await expect(scopeTag).toHaveText("One layer");
    await expect(page.locator("[data-dag-edge-layer] > g").first()).toHaveClass(/opacity-15/);
    await page.waitForTimeout(600);
    await taskC.click();
    await expect(scopeTag).toHaveText("All upstream + downstream", { timeout: 3_000 });
    await page.waitForTimeout(600);
    await taskC.click();
    await expect(scopeTag).toHaveText("One layer", { timeout: 3_000 });

    // A double-click keeps its original action and never lands in the closure:
    // the detail opens, and the restored selection is back at one layer.
    await taskC.dblclick();
    await expect(page).toHaveURL(new RegExp(`/issues/${c.id}`), { timeout: 30_000 });
    await page.goBack();
    await expect(page.locator("[data-dag-task]")).toHaveCount(2, { timeout: 30_000 });
    await expect(selection.locator("[data-dag-scope]")).toHaveText("One layer");

    // Opening the detail and coming back restores the line and its viewport.
    const lineViewport = await readViewport(page);
    await selectThenDblclick(page, taskC);
    await expect(page).toHaveURL(new RegExp(`/issues/${c.id}`), { timeout: 30_000 });
    await page.goBack();
    await expect(page.locator("[data-dag-task]")).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(() => readViewport(page)).toEqual(lineViewport);

    // Back to the overview: the panned viewport returns and line B is selected.
    await page.getByRole("button", { name: "Back to overview" }).click();
    await expect(cards).toHaveCount(3);
    await expect.poll(() => readViewport(page)).toEqual(overviewViewport);
    await expect(selection).toContainText("validation and delivery");

    // The independent group opens as its own grid level.
    await selectThenDblclick(page, page.locator('[data-dag-overview-card="independent:root"]'));
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "Independent issues",
    );
    await expect(page.locator("[data-dag-task]")).toHaveCount(1);
    await expect(page.locator("[data-dag-task]")).toContainText("independent note");
    await page.getByRole("button", { name: "Back to overview" }).click();
    await expect(cards).toHaveCount(3);

    // A direct double-click on an unselected overview card enters its line —
    // no selection click first (the independent card holds the selection here).
    await cardA.dblclick();
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "design and implementation",
    );
    await expect(page.locator("[data-dag-task]")).toHaveCount(2);
    await page.getByRole("button", { name: "Back to overview" }).click();
    await expect(cards).toHaveCount(3);

    // Refresh restores the current level: return into line A and reload.
    await selectThenDblclick(page, cardA);
    await expect(page.locator("[data-dag-task]")).toHaveCount(2);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("navigation", { name: "Task line path" }),
    ).toContainText("design and implementation", { timeout: 30_000 });
    await expect(page.locator("[data-dag-task]")).toHaveCount(2);

    expect(errors).toEqual([]);
  } finally {
    await api.cleanup();
    if (workspace) {
      const response = await fetch(`${API_BASE}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${api.getToken()}` },
      });
      if (!response.ok && response.status !== 404)
        throw new Error(`DAG fixture cleanup failed: ${response.status}`);
    }
  }
});

test("DAG auto-enters a single visible line only until the user returns", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const api = new TestApiClient();
  const stamp = `${Date.now()}-auto`;
  let workspace: { id: string; slug: string } | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api.login(`dag-auto-${stamp}@localhost`, "DAG Auto Enter");
    workspace = await api.ensureWorkspace(`DAG Auto Enter ${stamp}`, `dag-auto-${stamp}`);
    await api.markUserOnboarded();
    const line = await api.createIssue("DAG auto: only line");
    await api.createIssue("DAG auto: child", { parent_issue_id: line.id });

    await bootGraph(page, api, workspace, baseURL!);
    // One visible line: the overview hands over directly.
    await expect(page.locator("[data-dag-task]").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "only line",
    );

    // Deliberately returning pins the overview — no bounce back into the line.
    await page.getByRole("button", { name: "Back to overview" }).click();
    const cards = page.locator("[data-dag-overview-card]");
    await expect(cards).toHaveCount(1);
    await page.waitForTimeout(800);
    await expect(cards).toHaveCount(1);

    // The pin survives a reload; a double-click re-enters.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(800);
    await expect(cards).toHaveCount(1);
    await selectThenDblclick(page, cards.first());
    await expect(page.locator("[data-dag-task]").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Task line path" })).toContainText(
      "only line",
    );
    expect(errors).toEqual([]);
  } finally {
    await api.cleanup();
    if (workspace) {
      const response = await fetch(`${API_BASE}/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${api.getToken()}` },
      });
      if (!response.ok && response.status !== 404)
        throw new Error(`DAG fixture cleanup failed: ${response.status}`);
    }
  }
});
