import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";
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

async function enterFocus(page: Page, taskId: string) {
  await page.locator(`.react-flow__node[data-id="${taskId}"]`).click();
  const entry = page.locator("[data-dag-enter-focus]");
  if (!(await entry.isVisible()))
    await page.getByRole("region", { name: "Selection" }).getByRole("button", { name: "More", exact: true }).click();
  await entry.click();
  await expect(page.locator('[data-dag-level="focus"]')).toHaveAttribute("data-dag-scene", taskId);
}

const readViewport = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });

test("DAG levels: overview cards, line and focus navigation, bundles and persistence", async ({
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
    await cardA.click();
    await page.getByRole("region", { name: "Selection" }).getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator("[data-dag-enter-focus]")).toHaveCount(0);
    await page.keyboard.press("Escape");
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

    // Hovering never lights or dims anything (OL-996): resting the pointer on
    // a card for well past the old 100 ms debounce must not create the
    // overlay layer or any lit route, and must not write a selection.
    const hoverBox = (await cardA.boundingBox())!;
    await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height / 2);
    await page.waitForTimeout(250);
    await expect(page.locator("[data-dag-overlay-layer]")).toHaveCount(0);
    await expect(page.locator("[data-dag-lit-edge]")).toHaveCount(0);
    await expect(page.locator("[data-dag-edge-layer] > g").first()).not.toHaveClass(/opacity-15/);

    // A click, by contrast, selects the card and lights its neighborhood.
    await cardA.click();
    await expect(page.locator("[data-dag-lit-edge]").first()).toBeAttached();
    await expect(page.locator("[data-dag-edge-layer] > g").first()).toHaveClass(/opacity-15/);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-dag-overlay-layer]")).toHaveCount(0);

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
    // Painted-pixel baseline for the dimming regression gate below: d is not
    // on c's prerequisite chain, so focusing must actually repaint it dimmer.
    const dimmedClip = (await page
      .locator(`.react-flow__node[data-id="${d.id}"] [data-dag-task]`)
      .boundingBox())!;
    const dimmedBefore = await page.screenshot({ clip: dimmedClip });
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
    // Node dimming is a masked overlay above the z-index-2 cards: holes over
    // the lit cards, none over d, and d's pixels really change (OL-284 review:
    // the mask used to sit under the cards, dimming nothing).
    const dimLayer = page.locator("[data-dag-overlay-layer]");
    await expect(dimLayer).toHaveCount(1);
    expect(await dimLayer.evaluate((el) => getComputedStyle(el).zIndex)).toBe("3");
    // c is the focus anchor (lit through a hole); d is downstream (no hole).
    await expect(page.locator(`[data-dag-dim-hole="${c.id}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-dag-dim-hole="${d.id}"]`)).toHaveCount(0);
    const dimmedAfter = await page.screenshot({ clip: dimmedClip });
    expect(dimmedBefore.equals(dimmedAfter)).toBe(false);
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

    // The lit chain paints above the dim mask: sample the lit route's
    // midpoint — well clear of both cards — and require it does not get
    // LIGHTER once dimming is on (OL-284 review: it used to sit under the
    // mask and fade to 75% background like everything else).
    const litPoint = await page.evaluate(() => {
      const viewport = document.querySelector(".react-flow__viewport")!;
      const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
        viewport.getAttribute("style") ?? "",
      )!;
      const [tx, ty, zoom] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const paneRect = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
      const cardBoxes = [...document.querySelectorAll(".react-flow__node")].map((node) => {
        const el = node as HTMLElement;
        const xy = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)!;
        return {
          x: Number(xy[1]) - 8,
          y: Number(xy[2]) - 8,
          width: el.offsetWidth / zoom + 16,
          height: el.offsetHeight / zoom + 16,
        };
      });
      const clearance = (x: number, y: number) =>
        Math.min(
          ...cardBoxes.map(
            (b) =>
              Math.max(b.x - x, 0, x - (b.x + b.width)) ** 2 +
              Math.max(b.y - y, 0, y - (b.y + b.height)) ** 2,
          ),
        );
      let best: { x: number; y: number } | null = null;
      let bestClearance = 0;
      for (const polyline of document.querySelectorAll("[data-dag-lit-edge] polyline")) {
        const points = (polyline.getAttribute("points") ?? "")
          .trim()
          .split(/\s+/)
          .map((pair) => pair.split(",").map(Number));
        for (let i = 0; i + 1 < points.length; i++) {
          const [x1, y1] = points[i]!;
          const [x2, y2] = points[i + 1]!;
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          const c = clearance(mx, my);
          if (c > bestClearance) {
            bestClearance = c;
            best = { x: mx, y: my };
          }
        }
      }
      if (!best || bestClearance < 64) return null;
      return { x: paneRect.x + best.x * zoom + tx, y: paneRect.y + best.y * zoom + ty };
    });
    expect(litPoint).toBeTruthy();
    const minLuminance = (buffer: Buffer) => {
      const png = PNG.sync.read(buffer);
      let min = 255;
      for (let i = 0; i < png.data.length; i += 4)
        min = Math.min(
          min,
          0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!,
        );
      return min;
    };
    const clipOf = { x: litPoint!.x - 3, y: litPoint!.y - 3, width: 7, height: 7 };
    const litBrightness = minLuminance(await page.screenshot({ clip: clipOf }));
    await taskC.focus();
    await page.keyboard.press("Escape");
    const paneBox = (await page.locator(".react-flow__pane").boundingBox())!;
    await page.mouse.move(paneBox.x + paneBox.width - 16, paneBox.y + 16);
    await expect(page.locator("[data-dag-overlay-layer]")).toHaveCount(0);
    const normalBrightness = minLuminance(await page.screenshot({ clip: clipOf }));
    expect(litBrightness).toBeLessThanOrEqual(normalBrightness + 4);
    await taskC.click();
    await expect(scopeTag).toHaveText("One layer", { timeout: 3_000 });

    await taskC.dblclick();
    await expect(page).toHaveURL(new RegExp(`/issues/${c.id}`), { timeout: 30_000 });
    await page.goBack();
    await expect(page.locator("[data-dag-task]")).toHaveCount(2, { timeout: 30_000 });
    await expect(selection.locator("[data-dag-scope]")).toHaveText("One layer");

    // Focus is part of this retained gate: entry keeps cross-line content,
    // omits empty ancestor fragments and restores the viewport through the path.
    const beforeFocus = await readViewport(page);
    await enterFocus(page, c.id);
    await expect(page.locator(`.react-flow__node[data-id="${b.id}"]`)).toBeAttached();
    await expect(page.locator(`.react-flow__node[data-id="${d.id}"]`)).toBeAttached();
    const frameFragments = await page.locator("[data-dag-frame]").evaluateAll((frames) =>
      frames.map((frame) => JSON.parse(frame.getAttribute("data-dag-frame")!)),
    );
    expect(frameFragments).not.toContainEqual(["focus-frame", "upstream", lineB.id]);
    await expect(page.locator("[data-dag-enter-focus]")).toHaveCount(0);
    const path = page.getByRole("navigation", { name: "Task line path" });
    await path.getByRole("button", { name: /validation and delivery/ }).click();
    await expect(page.locator('[data-dag-level="line"]')).toHaveAttribute("data-dag-scene", lineB.id);
    await expect.poll(() => readViewport(page)).toEqual(beforeFocus);
    await enterFocus(page, c.id);
    await path.getByRole("button", { name: "All task lines", exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(page.locator('[data-dag-level="focus"]')).toHaveCount(0);
    await expect.poll(() => readViewport(page)).toEqual(overviewViewport);
    await selectThenDblclick(page, page.locator(`[data-dag-overview-card="issue:${lineB.id}"]`));
    await expect(page.locator("[data-dag-task]")).toHaveCount(2);

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
    await enterFocus(page, solo.id);
    await expect(page.locator("[data-dag-focus-hidden]")).toHaveCount(0);
    await page.getByRole("navigation", { name: "Task line path" }).getByRole("button", { name: "All task lines", exact: true }).click();
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
