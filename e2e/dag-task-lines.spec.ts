import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1050 } });

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;

// Real application + real isolated backend. No agents/runtimes are created or
// assigned. TestApiClient owns the ephemeral issue setup and cleanup.
for (const direction of ["LR", "TB"] as const) {
  test(`DAG task lines preserve stages, real routes and independent expansion (${direction})`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const api = new TestApiClient();
    const stamp = `${Date.now()}-${direction.toLowerCase()}`;
    let workspace: { id: string; slug: string } | undefined;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await api.login(`dag-elk-${stamp}@localhost`, "DAG Regression");
      workspace = await api.ensureWorkspace(`DAG Regression ${stamp}`, `dag-elk-${stamp}`);
      await api.markUserOnboarded();
      const token = api.getToken()!;
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
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Workspace-ID": workspace.id,
      };
      for (const [id, blockedBy] of [
        [b.id, [a.id]],
        [c.id, [a.id, b.id]],
        [d.id, [c.id]],
      ] as [string, string[]][]) {
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
      await context.addCookies([{ name: "multica-locale", value: "en", url: baseURL! }]);
      await page.addInitScript((value) => localStorage.setItem("multica_token", value), token);
      await page.goto(`/${workspace.slug}/issues`, { waitUntil: "domcontentloaded" });
      const mode = page.getByRole("button", { name: /^(Board|List|Table|Graph)$/ }).first();
      await expect(mode).toBeVisible({ timeout: 30_000 });
      if ((await mode.innerText()).trim() !== "Graph") {
        await mode.click();
        await page.getByText("Graph", { exact: true }).last().click();
      }
      await expect(page.locator("[data-dag-group]")).toHaveCount(3, { timeout: 30_000 });
      if (direction === "TB") {
        await page.getByRole("button", { name: /^Display$/ }).click();
        await page.getByRole("combobox", { name: "Direction" }).click();
        await page.getByRole("option", { name: "Top to bottom" }).click();
        await page.keyboard.press("Escape");
      }
      await expect(page.getByRole("button", { name: "2 dependencies", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "2 dependencies", exact: true }).click();
      await expect(page.getByRole("dialog").locator("li")).toHaveCount(2);
      await page.getByRole("dialog").getByRole("button", { name: "Clear selection" }).click();
      const viewportBefore = await page.locator(".react-flow__viewport").getAttribute("style");
      await page.getByRole("button", { name: "Expand issue groups", exact: true }).click();
      await expect(page.locator("[data-dag-issue]")).toHaveCount(4);
      await expect(page.locator(".react-flow__edge")).toHaveCount(4);
      await expect(page.locator('[data-dag-group="independent:root"]')).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(
        viewportBefore,
      );
      const aNode = page.locator(`.react-flow__node[data-id="${a.id}"]`);
      const bNode = page.locator(`.react-flow__node[data-id="${b.id}"]`);
      const aBounds = (await aNode.boundingBox())!,
        bBounds = (await bNode.boundingBox())!;
      expect(direction === "LR" ? aBounds.x < bBounds.x : aBounds.y < bBounds.y).toBe(true);
      expect(aBounds.width).toBeGreaterThan(200);
      await expect(aNode).toContainText("agreed design");
      await expect(
        page.locator(`[data-dag-group="issue:${lineA.id}"] [data-dag-stage]`),
      ).toHaveCount(2);
      await bNode.click();
      await expect(page.locator(".react-flow__edge-path.stroke-brand")).toHaveCount(2);
      const active = await page
        .locator(".react-flow__edge-path.stroke-brand")
        .first()
        .evaluate((el) => getComputedStyle(el).stroke);
      const quiet = await page
        .locator(".react-flow__edge-path:not(.stroke-brand)")
        .first()
        .evaluate((el) => getComputedStyle(el).stroke);
      expect(active).not.toBe(quiet);
      await bNode.focus();
      await page.keyboard.press("Escape");
      await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
      await expect(page.locator(".react-flow__edge-path.stroke-brand")).toHaveCount(0);
      const edge = page.locator(".react-flow__edge").first();
      await edge.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // A default viewport would let a reset masquerade as successful restoration.
      // Move both axes and change zoom before recording the navigation baseline.
      const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return { x: matrix.e, y: matrix.f, zoom: matrix.a };
      });
      const beforePan = await readViewport();
      const panArea = (await page.locator("[data-dag-canvas]").boundingBox())!;
      await page.mouse.move(panArea.x + panArea.width / 2, panArea.y + panArea.height / 2);
      await page.mouse.wheel(64, 72);
      await expect.poll(async () => (await readViewport()).x).not.toBe(beforePan.x);
      await expect.poll(async () => (await readViewport()).y).not.toBe(beforePan.y);
      await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
      await expect.poll(async () => (await readViewport()).zoom).not.toBe(beforePan.zoom);
      const viewportBeforeDetails = await readViewport();
      expect(viewportBeforeDetails.zoom).not.toBe(1);
      expect(viewportBeforeDetails).not.toEqual({ x: 20, y: 20, zoom: 1 });
      await bNode.dblclick();
      // A dev server compiles the detail route on first navigation. Keep the
      // same readiness allowance as the initial workspace route above.
      await expect(page).toHaveURL(new RegExp(`/issues/${b.id}`), { timeout: 30_000 });
      await page.goBack();
      await expect(page.locator("[data-dag-issue]")).toHaveCount(4);
      await expect.poll(readViewport).toEqual(viewportBeforeDetails);
      // Fold only task lines so the independent header can be reached at normal scale.
      await page.getByRole("button", { name: "Collapse issue groups", exact: true }).click();
      const independent = page.locator('[data-dag-group="independent:root"]');
      await independent.getByRole("button", { name: "Independent issues", exact: true }).click();
      await expect(page.locator(`.react-flow__node[data-id="${solo.id}"]`)).toBeVisible();
      await page.getByRole("button", { name: "Expand issue groups", exact: true }).click();
      await expect(page.locator("[data-dag-issue]")).toHaveCount(5);
      await page.getByRole("button", { name: "Collapse issue groups", exact: true }).click();
      await expect(independent).toHaveAttribute("data-collapsed", "false");
      await expect(page.locator("[data-dag-issue]")).toHaveCount(1);
      // Bounds must survive content shrink, not merely keep nodes mounted offscreen.
      const visibleContent = () =>
        page.evaluate(() => {
          const canvas = document.querySelector("[data-dag-canvas]")!.getBoundingClientRect();
          const items = [
            ...document.querySelectorAll("[data-dag-issue]"),
            ...Array.from(
              document.querySelectorAll("[data-dag-group] button[aria-expanded]"),
              (button) => button.parentElement!,
            ),
          ];
          return items.filter((item) => {
            const r = item.getBoundingClientRect();
            return (
              Math.min(r.right, canvas.right) - Math.max(r.left, canvas.left) >=
                Math.min(100, r.width) - 1 &&
              Math.min(r.bottom, canvas.bottom) - Math.max(r.top, canvas.top) >=
                Math.min(40, r.height) - 1
            );
          }).length;
        });
      const zoom = () =>
        page
          .locator(".react-flow__viewport")
          .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
      const canvas = (await page.locator("[data-dag-canvas]").boundingBox())!;
      await page.getByRole("button", { name: "Expand issue groups", exact: true }).click();
      await expect(page.locator("[data-dag-issue]")).toHaveCount(5);
      const originalZoom = await zoom();
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      await page.mouse.wheel(5000, 5000);
      await expect.poll(visibleContent).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Collapse issue groups", exact: true }).click();
      await expect(page.locator("[data-dag-issue]")).toHaveCount(1);
      await page.getByRole("toolbar").getByRole("button", { name: "Collapse", exact: true }).click();
      await expect(page.locator("[data-dag-issue]")).toHaveCount(0);
      await expect.poll(visibleContent).toBeGreaterThan(0);
      expect(await zoom()).toBe(originalZoom);
      expect(errors).toEqual([]);
      await testInfo.attach(`dag-${direction}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
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
}
