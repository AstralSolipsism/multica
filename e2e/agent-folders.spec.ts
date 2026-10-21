import "./env";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

// OL-1030: agents page folder explorer end-to-end. Covers the acceptance
// flow: create a folder in the current location, move an agent into it, a
// newly created squad's folder shows up at the root without a refresh, the
// squad folder moves into a custom folder, a squad member is additionally
// placed into another custom folder and appears in both, then breadcrumbs
// navigate back to the root.

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

// Optional screenshot evidence (same convention as QUICK_ACTIONS_SCREENSHOT_PATH).
const SHOT_DIR = process.env.AGENT_FOLDERS_SCREENSHOT_DIR;

const AGENTS = ["Alpha", "Beta", "Gamma"] as const;

test("agents page folder explorer: folders, squad folders, and placements", async ({
  page,
}) => {
  test.setTimeout(120000);
  const api: TestApiClient = await createTestApi();
  const db = new pg.Client(DATABASE_URL);
  await db.connect();

  let runtimeId: string | null = null;
  const agentIds: string[] = [];
  let squadId: string | null = null;

  try {
    const workspace = (await api.getWorkspaces())[0];
    if (!workspace) throw new Error("E2E workspace missing");
    api.setWorkspaceId(workspace.id);
    api.setWorkspaceSlug(workspace.slug);

    const user = await db.query<{ id: string }>(
      `SELECT id::text FROM "user" WHERE email = $1 LIMIT 1`,
      [api.getEmail()],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("E2E user missing");

    const runtime = await db.query<{ id: string }>(
      `INSERT INTO agent_runtime (
         workspace_id, daemon_id, name, runtime_mode, provider, status,
         device_info, metadata, last_seen_at
       )
       VALUES ($1, NULL, $2, 'cloud', 'e2e_agent_folders', 'online', $3, '{}'::jsonb, now())
       RETURNING id::text`,
      [workspace.id, `Agent folders ${Date.now()}`, "Agent folders E2E"],
    );
    runtimeId = runtime.rows[0]!.id;

    for (const name of AGENTS) {
      const agent = await db.query<{ id: string }>(
        `INSERT INTO agent (
           workspace_id, name, description, instructions, runtime_mode,
           runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id
         )
         VALUES ($1, $2, '', '', 'cloud', '{}'::jsonb, $3, 'workspace', 1, $4)
         RETURNING id::text`,
        [workspace.id, name, runtimeId, userId],
      );
      agentIds.push(agent.rows[0]!.id);
    }
    const [alphaId, betaId, gammaId] = agentIds as [string, string, string];

    // The second custom folder exists up front; the first one is created
    // through the UI as part of the flow.
    await api.postJson("/api/agent-folders", { name: "Research", parent_id: "" });

    const token = api.getToken();
    if (!token) throw new Error("E2E token missing");
    await page.addInitScript((authToken) => {
      localStorage.setItem("multica_token", authToken);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, token);

    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/${workspace.slug}/agents`, { waitUntil: "domcontentloaded" });

    // Root: the three agents and the pre-made Research folder, nothing else.
    const rootBreadcrumb = page.getByRole("button", {
      name: "Agents",
      exact: true,
    });
    await expect(rootBreadcrumb).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Open Research" })).toBeVisible();
    for (const name of AGENTS) {
      await expect(
        page.locator('[role="row"]', { hasText: name }).first(),
      ).toBeVisible();
    }

    // 1. Create a folder at the current location (the root).
    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByLabel("Name").fill("Design");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("button", { name: "Open Design" })).toBeVisible();

    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/01-root.png` });

    // 2. Move Alpha into Design from its row menu.
    const alphaRow = page.locator('[role="row"]', { hasText: "Alpha" });
    await alphaRow.getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Move to..." }).click();
    await page.getByRole("button", { name: "Design", exact: true }).click();
    await page.getByRole("button", { name: "Move", exact: true }).click();
    // Alpha left the root.
    await expect(
      page.locator('[role="row"]', { hasText: "Alpha" }),
    ).toHaveCount(0);

    // 3. Create a squad via the API: its squad folder appears at the root
    //    without a manual refresh (realtime invalidation).
    const squad = await api.postJson<{ id: string }>("/api/squads", {
      name: "Game design",
      leader_id: betaId,
    });
    squadId = squad.id;
    await api.postJson(`/api/squads/${squadId}/members`, {
      member_type: "agent",
      member_id: gammaId,
      role: "member",
    });
    await expect(
      page.getByRole("button", { name: "Open Game design" }),
    ).toBeVisible({ timeout: 30000 });

    // 4. Move the squad folder into Design.
    await page.getByRole("button", { name: "Actions for Game design" }).click();
    await page.getByRole("menuitem", { name: "Move" }).click();
    await page.getByRole("button", { name: "Design", exact: true }).click();
    await page.getByRole("button", { name: "Move", exact: true }).click();
    // The squad folder left the root.
    await expect(
      page.getByRole("button", { name: "Open Game design" }),
    ).toHaveCount(0);

    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/02-squad-folder-at-root.png` });

    // 5. Inside Design: the squad folder and Alpha.
    await page.getByRole("button", { name: "Open Design" }).click();
    await expect(page.getByRole("button", { name: "Open Game design" })).toBeVisible();
    await expect(
      page.locator('[role="row"]', { hasText: "Alpha" }),
    ).toBeVisible();

    // 6. Inside the squad folder: Beta (leader) and Gamma. Additionally place
    //    Gamma into Research — it must stay listed here.
    await page.getByRole("button", { name: "Open Game design" }).click();
    await expect(
      page.locator('[role="row"]', { hasText: "Beta" }),
    ).toBeVisible();
    const gammaRow = page.locator('[role="row"]', { hasText: "Gamma" });
    await expect(gammaRow).toBeVisible();
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/03-squad-folder.png` });
    await gammaRow.getByRole("button", { name: "Row actions" }).click();
    await page
      .getByRole("menuitem", { name: "Also place in folder..." })
      .click();
    await page.getByRole("button", { name: "Research", exact: true }).click();
    if (SHOT_DIR) {
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${SHOT_DIR}/04-place-dialog.png` });
    }
    await page.getByRole("button", { name: "Place", exact: true }).click();
    // Gamma remains in the squad folder…
    await expect(
      page.locator('[role="row"]', { hasText: "Gamma" }),
    ).toBeVisible();

    // …and also appears inside Research.
    await page.getByRole("button", { name: "Design", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Open Research" }).click();
    await expect(
      page.locator('[role="row"]', { hasText: "Gamma" }),
    ).toBeVisible();

    // 7. Breadcrumb back to the root: both custom folders, no squad folder
    //    (it lives inside Design), and only the uncategorized agents (none
    //    left — Alpha is placed, Beta/Gamma are squad members).
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open Design" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Research" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Game design" }),
    ).toHaveCount(0);
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/05-back-at-root.png` });
    for (const name of AGENTS) {
      await expect(
        page.locator('[role="row"]', { hasText: name }),
      ).toHaveCount(0);
    }
  } finally {
    if (squadId) {
      await db.query(`DELETE FROM squad_member WHERE squad_id = $1`, [squadId]);
      await db.query(`DELETE FROM squad WHERE id = $1`, [squadId]);
    }
    await db.query(
      `DELETE FROM labrastro_agent_placement WHERE workspace_id = (SELECT workspace_id FROM agent_runtime WHERE id = $1)`,
      [runtimeId],
    );
    await db.query(
      `DELETE FROM labrastro_agent_squad_placement WHERE workspace_id = (SELECT workspace_id FROM agent_runtime WHERE id = $1)`,
      [runtimeId],
    );
    await db.query(
      `DELETE FROM labrastro_agent_folder WHERE workspace_id = (SELECT workspace_id FROM agent_runtime WHERE id = $1)`,
      [runtimeId],
    );
    for (const id of agentIds) {
      await db.query(`DELETE FROM agent WHERE id = $1`, [id]);
    }
    if (runtimeId) {
      await db.query(`DELETE FROM agent_runtime WHERE id = $1`, [runtimeId]);
    }
    await db.end();
    await api.cleanup();
  }
});
