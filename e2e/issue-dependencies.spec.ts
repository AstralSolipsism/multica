import { test, expect, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";
import { waitForPageText } from "./helpers";

// OL-44 — dependency editing + human early-dispatch confirmation against the
// REAL server (OL-39/41 endpoints), not a mocked boundary. The agent/runtime
// are DB-seeded fakes: the override is proven by the queue row the server
// writes, never by an actual agent execution.

const E2E_WORKER =
  process.env.TEST_PARALLEL_INDEX ?? process.env.TEST_WORKER_INDEX ?? "0";
const E2E_RUN_ID =
  process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const EMAIL = `e2e-dep-${E2E_WORKER}-${E2E_RUN_ID}@multica.ai`;
const NAME = "E2E Dependency User";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || "8080"}`;

interface Ctx {
  api: TestApiClient;
  token: string;
  workspaceId: string;
  workspaceSlug: string;
  userId: string;
  agentId: string;
  runtimeId: string;
  issueA: { id: string; identifier: string };
  issueB: { id: string; identifier: string };
  issueC: { id: string; identifier: string };
}

async function sql<T = Record<string, unknown>>(
  query: string,
  params: unknown[],
): Promise<T[]> {
  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  try {
    const res = await client.query(query, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

/** The exact read→replace flow the editor drives (OL-39 compound write). */
async function setBlockedBy(ctx: Ctx, issueId: string, blockedBy: string[]) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.token}`,
    "X-Workspace-ID": ctx.workspaceId,
  };
  const depsRes = await fetch(`${API_BASE}/api/issues/${issueId}/dependencies`, {
    headers,
  });
  if (!depsRes.ok) throw new Error(`dependencies read failed: ${depsRes.status}`);
  const view = (await depsRes.json()) as { dependency_version: string };
  const writeRes = await fetch(`${API_BASE}/api/issues/${issueId}/with-dependencies`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      blocked_by: blockedBy,
      expected_dependency_version: view.dependency_version,
    }),
  });
  if (!writeRes.ok) {
    throw new Error(`dependency write failed: ${writeRes.status} ${await writeRes.text()}`);
  }
}

async function getBlockedBy(ctx: Ctx, issueId: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/issues/${issueId}/dependencies`, {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "X-Workspace-ID": ctx.workspaceId,
    },
  });
  const view = (await res.json()) as { blocked_by: { issue_id: string }[] };
  return view.blocked_by.map((p) => p.issue_id);
}

async function setup(): Promise<Ctx> {
  const api = new TestApiClient();
  const login = await api.login(EMAIL, NAME);
  const userId: string | undefined = login?.user?.id;
  if (!userId) throw new Error("login did not return a user id");
  const workspace = await api.ensureWorkspace(
    `E2E Dep WS ${E2E_WORKER}`,
    `e2e-dep-${E2E_WORKER}-${E2E_RUN_ID}`,
  );
  await api.markUserOnboarded();
  const token = api.getToken();
  if (!token) throw new Error("login did not return a token");

  const runtimeRows = await sql<{ id: string }>(
    `INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, visibility, owner_id, last_seen_at)
     VALUES ($1, NULL, 'E2E fake runtime', 'cloud', 'e2e_fake', 'online', 'private', $2, now())
     RETURNING id`,
    [workspace.id, userId],
  );
  const runtimeId = runtimeRows[0]!.id;
  const agentRows = await sql<{ id: string }>(
    `INSERT INTO agent (workspace_id, name, description, runtime_id, runtime_mode, visibility, status, max_concurrent_tasks, owner_id)
     VALUES ($1, 'E2E Dependency Agent', '', $2, 'cloud', 'private', 'idle', 1, $3)
     RETURNING id`,
    [workspace.id, runtimeId, userId],
  );
  const agentId = agentRows[0]!.id;

  const a = await api.createIssue("Prerequisite A", { status: "todo" });
  const b = await api.createIssue("Blocked B", { status: "todo" });
  const c = await api.createIssue("Cancel Cand C", { status: "todo" });

  const ctx: Ctx = {
    api,
    token,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    userId,
    agentId,
    runtimeId,
    issueA: { id: a.id, identifier: a.identifier },
    issueB: { id: b.id, identifier: b.identifier },
    issueC: { id: c.id, identifier: c.identifier },
  };
  // B and C both wait on A, registered through the real compound write path.
  await setBlockedBy(ctx, ctx.issueB.id, [ctx.issueA.id]);
  await setBlockedBy(ctx, ctx.issueC.id, [ctx.issueA.id]);
  return ctx;
}

async function enterWorkspace(page: Page, ctx: Ctx) {
  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, ctx.token);
}

async function expectReadablePrerequisite(container: Locator, title: string) {
  const label = container.getByText(title, { exact: true });
  await expect(label).toBeVisible();
  const bounds = await label.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(bounds.width).toBeGreaterThan(100);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
  expect(await container.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
}

async function cleanup(ctx: Ctx) {
  // No FK cascade by design (repo rule): remove the relation + queue rows
  // first, then the issues, runtime and agent.
  await sql(
    `DELETE FROM issue_dependency WHERE issue_id = ANY($1::uuid[]) OR depends_on_issue_id = ANY($1::uuid[])`,
    [[ctx.issueA.id, ctx.issueB.id, ctx.issueC.id]],
  );
  await sql(`DELETE FROM agent_task_queue WHERE agent_id = $1`, [ctx.agentId]);
  await ctx.api.cleanup();
  await sql(`DELETE FROM agent WHERE id = $1`, [ctx.agentId]);
  await sql(`DELETE FROM agent_runtime WHERE id = $1`, [ctx.runtimeId]);
}

test.describe("Issue dependencies (OL-44)", () => {
  test.setTimeout(120_000);
  let ctx: Ctx;

  test.beforeAll(async () => {
    ctx = await setup();
  });

  test.afterAll(async () => {
    if (ctx) await cleanup(ctx);
  });

  test("detail shows unfinished prerequisites and the editor removes/re-adds them", async ({
    page,
  }) => {
    await enterWorkspace(page, ctx);
    await page.goto(`/${ctx.workspaceSlug}/issues/${ctx.issueB.id}`, {
      waitUntil: "domcontentloaded",
    });
    // The issue title alone also matches the list row — wait for the detail's
    // Properties panel so we know the detail page (and its sidebar) mounted.
    await expect(page.locator("text=Properties").first()).toBeVisible({ timeout: 30000 });
    await waitForPageText(page, "Blocked B");

    // The sidebar section names the direct prerequisite, its unfinished state,
    // and stays one consistent surface with the editor.
    await expect(page.getByText("Prerequisites").first()).toBeVisible();
    await expect(page.getByText("Prerequisite A").first()).toBeVisible();
    await expect(page.getByText("1 prerequisite unfinished")).toBeVisible();

    // Remove via the shared editor.
    await page.getByRole("button", { name: "Edit prerequisites" }).first().click();
    const editor = page.getByRole("dialog", { name: "Edit prerequisites" });
    await expect(editor).toBeVisible({ timeout: 30000 });
    await editor
      .getByRole("button", { name: `Remove prerequisite ${ctx.issueA.identifier}` })
      .click();
    await editor.getByRole("button", { name: "Save" }).click();
    // Editor closed; the section now shows no direct prerequisites.
    await expect(editor).not.toBeVisible();
    await expect
      .poll(() => getBlockedBy(ctx, ctx.issueB.id))
      .toEqual([]);

    // Re-add via the Relations menu entry (the section is hidden while empty,
    // so the menu is the always-available entry point) — then the same editor.
    await page.getByRole("button", { name: "Issue actions" }).click();
    await page.getByText("Relations", { exact: true }).click();
    const editItem = page.getByText("Edit prerequisites...");
    await expect(editItem).toBeVisible({ timeout: 15000 });
    await editItem.click();
    const editor2 = page.getByRole("dialog", { name: "Edit prerequisites" });
    await expect(editor2).toBeVisible({ timeout: 30000 });
    await editor2.getByPlaceholder("Search issues...").fill("Prerequisite A");
    const result = editor2.getByText(ctx.issueA.identifier, { exact: false }).first();
    await expect(result).toBeVisible({ timeout: 15000 });
    await result.click();
    await editor2.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => getBlockedBy(ctx, ctx.issueB.id))
      .toEqual([ctx.issueA.id]);
  });

  test("assigning an agent to a blocked issue asks once, and only the explicit override starts it", async ({
    page,
  }) => {
    await enterWorkspace(page, ctx);
    await page.goto(`/${ctx.workspaceSlug}/issues/${ctx.issueB.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("text=Properties").first()).toBeVisible({ timeout: 30000 });
    await waitForPageText(page, "Blocked B");

    // Cancel path first: opening the assignee picker and dismissing the
    // confirmation must not write anything.
    // The agent rows carry avatar hover cards that steal the pointer mid-click,
    // so the pick happens inside the picker popover with a forced click.
    const pickAgent = async () => {
      await page.getByText("Unassigned").first().click();
      const popover = page.locator('[data-slot="popover-content"]').last();
      await expect(popover).toBeVisible();
      await popover.getByPlaceholder("Assign to...").fill("E2E Dependency");
      const row = popover.getByText("E2E Dependency Agent").first();
      await expect(row).toBeVisible();
      await row.click({ force: true });
    };
    await pickAgent();
    await expect(page.getByText("Confirm assignment?")).toBeVisible();
    // The blocked panel lists the unfinished prerequisite before any choice.
    await expect(page.getByText("Prerequisites unfinished")).toBeVisible();
    await expect(
      page.getByText(ctx.issueA.identifier, { exact: false }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Confirm assignment?")).not.toBeVisible();
    let queueRows = await sql(
      `SELECT id FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`,
      [ctx.issueB.id, ctx.agentId],
    );
    expect(queueRows).toHaveLength(0);

    // Now the explicit one-shot override.
    await pickAgent();
    await expect(page.getByText("Prerequisites unfinished")).toBeVisible();
    await page.getByRole("button", { name: "Assign and start anyway" }).click();
    await expect(page.getByText("Confirm assignment?")).not.toBeVisible();

    // The server committed the assignment AND queued exactly one run carrying
    // the consumed one-shot admission record (OL-41 §5).
    await expect
      .poll(async () => {
        const rows = await sql<{ dependency_admission: unknown }>(
          `SELECT dependency_admission FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`,
          [ctx.issueB.id, ctx.agentId],
        );
        return rows.length === 1 && rows[0]!.dependency_admission !== null;
      })
      .toBe(true);

    // Cancel-on-confirm for C wrote nothing either: still unassigned, no run.
    const cRes = await fetch(`${API_BASE}/api/issues/${ctx.issueC.id}`, {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "X-Workspace-ID": ctx.workspaceId,
      },
    });
    const c = (await cRes.json()) as { assignee_id: string | null };
    expect(c.assignee_id).toBeNull();
    queueRows = await sql(
      `SELECT id FROM agent_task_queue WHERE issue_id = $1`,
      [ctx.issueC.id],
    );
    expect(queueRows).toHaveLength(0);
  });

  test("DAG actions edit in place and preserve cancel/one-shot assignment with readable prerequisites", async ({ page }, testInfo) => {
    const title = "跨项目依赖需要完整显示：" + "longunbrokenprerequisitetitle".repeat(4);
    await ctx.api.updateIssue(ctx.issueA.id, { title });
    await page.setViewportSize({ width: 1024, height: 768 });
    await enterWorkspace(page, ctx);
    await page.goto(`/${ctx.workspaceSlug}/issues`);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByText("Graph", { exact: true }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    const node = page.locator(`.react-flow__node[data-id="${ctx.issueC.id}"]`);
    await expect(node).toBeVisible();
    await node.click();
    const graphUrl = page.url();

    await page.getByRole("button", { name: "Edit prerequisites", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit prerequisites" });
    await expectReadablePrerequisite(editor, title);
    await editor.getByRole("button", { name: `Remove prerequisite ${ctx.issueA.identifier}` }).click();
    await page.keyboard.press("Escape");
    expect(await getBlockedBy(ctx, ctx.issueC.id)).toEqual([ctx.issueA.id]);
    expect(page.url()).toBe(graphUrl);

    // Save through the same entry, then restore the edge through the real API.
    await page.getByRole("button", { name: "Edit prerequisites", exact: true }).click();
    await editor.getByRole("button", { name: `Remove prerequisite ${ctx.issueA.identifier}` }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect.poll(() => getBlockedBy(ctx, ctx.issueC.id)).toEqual([]);
    await setBlockedBy(ctx, ctx.issueC.id, [ctx.issueA.id]);

    const before = await sql("SELECT assignee_id, revision FROM issue WHERE id = $1", [ctx.issueC.id]);
    const pickAgent = async () => {
      await page.getByRole("button", { name: "Assign", exact: true }).click();
      const picker = page.locator('[data-slot="popover-content"]').last();
      await picker.getByPlaceholder("Assign to...").fill("E2E Dependency");
      await picker.getByText("E2E Dependency Agent", { exact: true }).click({ force: true });
      await expect(page.getByText("Confirm assignment?", { exact: true })).toBeVisible();
    };
    await pickAgent();
    const confirmation = page.getByRole("dialog");
    await expectReadablePrerequisite(confirmation, title);
    await expect(confirmation.getByText(ctx.issueA.identifier, { exact: true })).toBeVisible();
    await testInfo.attach("dag-confirmation-readability", { body: await confirmation.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    expect(await sql("SELECT assignee_id, revision FROM issue WHERE id = $1", [ctx.issueC.id])).toEqual(before);
    expect(await sql("SELECT id FROM agent_task_queue WHERE issue_id = $1", [ctx.issueC.id])).toHaveLength(0);
    expect(page.url()).toBe(graphUrl);

    await pickAgent();
    await confirmation.getByRole("button", { name: "Assign and start anyway", exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect.poll(async () => {
      const rows = await sql<{ dependency_admission: unknown }>(
        "SELECT dependency_admission FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2",
        [ctx.issueC.id, ctx.agentId],
      );
      return rows.length === 1 && rows[0]!.dependency_admission !== null;
    }).toBe(true);
    expect(page.url()).toBe(graphUrl);
    // Node content must still respond to a real graph refresh.
    const updatedTitle = "Updated prerequisite in DAG";
    await ctx.api.updateIssue(ctx.issueA.id, { title: updatedTitle });
    await expect(
      page.locator(`.react-flow__node[data-id="${ctx.issueA.id}"]`).getByText(updatedTitle, { exact: true }),
    ).toBeVisible();
  });

  test("saved DAG at the view-bar overflow boundary reloads without losing expansion", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await enterWorkspace(page, ctx);
    await page.goto(`/${ctx.workspaceSlug}/issues`);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByText("Graph", { exact: true }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    const viewIds: string[] = [];
    try {
      // These label widths put the third saved view at the last fitting tab:
      // the old fitCount/reserveTier effects oscillated between 5 and 6 tabs.
      for (const name of ["OL45 saved DAG", "OL45 saved DAG", "OL45 saved DAG 1789114381162", "OL45 clean saved DAG 1789115242133"]) {
        await page.getByRole("button", { name: "Views", exact: true }).click();
        await page.getByText("New view", { exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByPlaceholder("e.g. Needs review").fill(name);
        const response = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/issue-views");
        await dialog.getByRole("button", { name: "Create view", exact: true }).click();
        viewIds.push((await (await response).json()).id);
        await expect(dialog).not.toBeVisible();
      }
      await page.goto(`/${ctx.workspaceSlug}/issues?view=${viewIds[2]}`);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await page.getByRole("button", { name: "Expand all", exact: true }).click();
      await expect(page.locator(`.react-flow__node[data-id="${ctx.issueC.id}"]`)).toBeVisible();
      await page.reload();
      await expect(page.locator(`.react-flow__node[data-id="${ctx.issueC.id}"]`)).toBeVisible();
      await expect(page.getByRole("button", { name: "OL45 saved DAG 1789114381162", exact: true })).toBeVisible();
      for (const width of [1024, 680, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        // The entire toolbar is hidden at the mobile breakpoint; the graph
        // and expanded state must survive it and return with the same tab.
        await expect(page.locator(`.react-flow__node[data-id="${ctx.issueC.id}"]`)).toBeVisible();
        if (width >= 1024) {
          await expect(page.getByRole("button", { name: "OL45 saved DAG 1789114381162", exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Graph", exact: true })).toBeVisible();
        }
      }
    } finally {
      for (const id of viewIds) await ctx.api.deleteIssueView(id);
    }
  });

  test("changing DAG direction keeps existing edges attached to their handles", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await enterWorkspace(page, ctx);
    await page.goto(`/${ctx.workspaceSlug}/issues`);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByText("Graph", { exact: true }).click();
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await page.evaluate(() => {
      const observer = new MutationObserver((changes) => {
        for (const change of changes) for (const removed of change.removedNodes) {
          if (removed instanceof Element && (removed.matches(".react-flow__edge") || removed.querySelector(".react-flow__edge"))) {
            document.documentElement.dataset.detachedDagEdges = "true";
          }
        }
      });
      observer.observe(document.querySelector(".react-flow__viewport")!, { childList: true, subtree: true });
    });
    await page.getByRole("button", { name: "Display", exact: true }).click();
    for (const [name, sourceSide, targetSide] of [["Top to bottom", "bottom", "top"], ["Left to right", "right", "left"]]) {
      await page.getByRole("combobox", { name: "Direction", exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
      await expect.poll(() => page.evaluate(({ sourceSide, targetSide }) => {
        const edges = Array.from(document.querySelectorAll(".react-flow__edge"));
        return edges.length === 2 && edges.every((edge) => {
          const match = edge.getAttribute("aria-label")?.match(/^Edge from (.+) to (.+)$/);
          if (!match) return false;
          const path = edge.querySelector<SVGPathElement>(".react-flow__edge-path")!;
          const matrix = path.getScreenCTM()!;
          return [[match[1], "source", sourceSide, 0], [match[2], "target", targetSide, path.getTotalLength()]].every(([id, type, side, length]) => {
            const handle = document.querySelector(`.react-flow__node[data-id="${id}"] .react-flow__handle.${type}.react-flow__handle-${side}`);
            if (!handle) return false;
            const rect = handle.getBoundingClientRect();
            const point = path.getPointAtLength(Number(length)).matrixTransform(matrix);
            // React Flow attaches at the port's outer edge, not its center.
            const x = side === "left" ? rect.left : side === "right" ? rect.right : rect.x + rect.width / 2;
            const y = side === "top" ? rect.top : side === "bottom" ? rect.bottom : rect.y + rect.height / 2;
            return Math.hypot(point.x - x, point.y - y) < 2;
          });
        });
      }, { sourceSide, targetSide })).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.dataset.detachedDagEdges)).toBeUndefined();
  });

  test("many inherited prerequisites remain reachable without hiding confirmation actions", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await enterWorkspace(page, ctx);
    const parent = await ctx.api.createIssue("Confirmation parent", { status: "todo" });
    const target = await ctx.api.createIssue("Confirmation target", { status: "todo", parent_issue_id: parent.id });
    const prerequisites: { id: string; identifier: string; title: string }[] = [];
    for (let i = 0; i < 12; i++) {
      prerequisites.push(await ctx.api.createIssue(`Authentication prerequisite ${i + 1}`, { status: "todo" }));
    }
    try {
      for (const long of [false, true]) {
        const active = prerequisites.slice(0, long ? 8 : 12);
        if (long) {
          for (const issue of active) {
            await ctx.api.updateIssue(issue.id, { title: `${issue.title}: cross-project authentication and authorization must be implemented before dispatch` });
          }
        }
        await setBlockedBy(ctx, parent.id, active.map((issue) => issue.id));
        await page.goto(`/${ctx.workspaceSlug}/issues/${target.id}`);
        await expect(page.getByText("Properties", { exact: true }).first()).toBeVisible();
        await page.getByText("Unassigned", { exact: true }).first().click();
        const picker = page.locator('[data-slot="popover-content"]').filter({
          has: page.getByPlaceholder("Assign to..."),
        });
        await picker.getByPlaceholder("Assign to...").fill("E2E Dependency");
        await picker.getByRole("button", { name: /E2E Dependency Agent$/ }).click();
        const dialog = page.getByRole("dialog");
        const confirm = dialog.getByRole("button", { name: "Assign and start anyway", exact: true });
        await expect(confirm).toBeEnabled();
        const assertActionsFit = async () => {
          for (const element of [dialog, confirm, dialog.getByRole("button", { name: "Don't start yet", exact: true }), dialog.getByRole("button", { name: "Close", exact: true })]) {
            await expect(element).toBeInViewport({ ratio: 1 });
          }
          await confirm.click({ trial: true });
        };
        await assertActionsFit();
        const first = dialog.getByRole("button").filter({ has: page.getByText(active[0]!.identifier, { exact: true }) });
        const last = dialog.getByRole("button").filter({ has: page.getByText(active.at(-1)!.identifier, { exact: true }) });
        await expect(first).toBeInViewport({ ratio: 1 });
        const content = dialog.locator(".overflow-y-auto");
        await content.hover();
        await page.mouse.wheel(0, 2000);
        await expect(last).toBeInViewport({ ratio: 1 });
        await assertActionsFit();
        // Keyboard focus must also scroll both ends into view, without a write.
        await dialog.getByRole("button", { name: "Close", exact: true }).focus();
        await page.keyboard.press("Tab");
        await expect(first).toBeFocused();
        await expect(first).toBeInViewport({ ratio: 1 });
        await dialog.getByRole("button", { name: "Don't start yet", exact: true }).focus();
        await page.keyboard.press("Shift+Tab");
        await expect(last).toBeFocused();
        await expect(last).toBeInViewport({ ratio: 1 });
        await assertActionsFit();
        await testInfo.attach(`many-prerequisites-${active.length}-bounds`, {
          body: Buffer.from(JSON.stringify(await dialog.evaluate((el) => ({
            dialog: el.getBoundingClientRect().toJSON(),
            content: el.querySelector(".overflow-y-auto")!.getBoundingClientRect().toJSON(),
            buttons: Array.from(el.querySelectorAll("[data-slot=dialog-footer] button")).map((button) => button.getBoundingClientRect().toJSON()),
          })))),
          contentType: "application/json",
        });
        await testInfo.attach(`many-prerequisites-${active.length}`, { body: await page.screenshot(), contentType: "image/png" });
        const before = await sql("SELECT assignee_id, revision FROM issue WHERE id = $1", [target.id]);
        if (long) {
          await confirm.click();
          await expect(dialog).not.toBeVisible();
          await expect.poll(async () => (await sql("SELECT id FROM agent_task_queue WHERE issue_id = $1", [target.id])).length).toBe(1);
        } else {
          await page.keyboard.press("Escape");
          await expect(dialog).not.toBeVisible();
          expect(await sql("SELECT assignee_id, revision FROM issue WHERE id = $1", [target.id])).toEqual(before);
          expect(await sql("SELECT id FROM agent_task_queue WHERE issue_id = $1", [target.id])).toHaveLength(0);
        }
      }
    } finally {
      await setBlockedBy(ctx, parent.id, []);
    }
  });
});
