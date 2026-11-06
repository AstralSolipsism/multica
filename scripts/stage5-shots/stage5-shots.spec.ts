// One-shot evidence script, never part of any suite. Run explicitly from repo root:
//   pnpm exec playwright test --config scripts/stage5-shots/playwright.stage5-shots.config.ts

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { TestApiClient } from "../../e2e/fixtures";

// Stage 5 (OL-1252) evidence capture: one disposable account tours the v0.8.x
// surfaces the sync must retain. Not a product test — each step only proves the
// page renders its retained feature, then screenshots it.

const DATABASE_URL = process.env.DATABASE_URL!; // required: this script writes fixtures directly
const SHOTS = "test-results/stage5-shots/screenshots";
const STAMP = `${Date.now()}`;

test.describe.configure({ mode: "serial" });

test.setTimeout(120_000);

let api: TestApiClient;
let slug = "";
const db = () => new pg.Client(DATABASE_URL);

test.beforeAll(async () => {
  api = new TestApiClient();
  await api.login(`stage5-shots-${STAMP}@multica.ai`, "Stage5 Shots");
  const ws = await api.ensureWorkspace(`Stage5 Shots ${STAMP}`, `stage5-shots-${STAMP}`);
  api.setWorkspaceId(ws.id);
  api.setWorkspaceSlug(ws.slug);
  await api.markUserOnboarded();
  slug = ws.slug;
});

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function auth(page: Page) {
  await page.addInitScript((token: string) => {
    localStorage.setItem("multica_token", token);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, api.getToken()!);
  await page.setViewportSize({ width: 1600, height: 1000 });
}

test("01 issues list — v1.0 dual-layer sidebar", async ({ page }) => {
  await auth(page);
  await page.goto(`/${slug}/issues`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "New Issue" }).first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1200); // let counts and secondary nav settle
  await shot(page, "01-issues-dual-sidebar");
});

test("02 DAG view with real lines", async ({ page }) => {
  await auth(page);
  const stamp = STAMP;
  const lineA = await api.createIssue(`Shot line: build ${stamp}`);
  const a = await api.createIssue("Shot task: spec", { parent_issue_id: lineA.id, stage: 1, status: "done" });
  const b = await api.createIssue("Shot task: build", { parent_issue_id: lineA.id, stage: 2 });
  await setBlockedBy(b.id, [a.id]);
  await page.goto(`/${slug}/issues`, { waitUntil: "domcontentloaded" });
  const display = page.getByRole("button", { name: "Display", exact: true });
  await expect(display).toBeVisible({ timeout: 30000 });
  await display.click();
  await page
    .getByRole("group", { name: "View", exact: true })
    .getByRole("button", { name: "Graph", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "All task lines" }).click();
  const cards = page.locator("[data-dag-overview-card]");
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);
  await shot(page, "02-dag-view");
});

test("03 agents folder tree + thinking level property", async ({ page }) => {
  await auth(page);
  const client = db();
  await client.connect();
  let runtimeId = "";
  let agentId = "";
  try {
    const user = await client.query<{ id: string }>(`SELECT id::text FROM "user" WHERE email = $1`, [
      api.getEmail(),
    ]);
    const ws = (await api.getWorkspaces())[0]!;
    const runtime = await client.query<{ id: string }>(
      `INSERT INTO agent_runtime (
         workspace_id, daemon_id, name, runtime_mode, provider, status,
         device_info, metadata, last_seen_at
       )
       VALUES ($1, NULL, $2, 'cloud', 'stage5_shots', 'online', $3, '{}'::jsonb, now())
       RETURNING id::text`,
      [ws.id, `Stage5 runtime ${STAMP}`, "Stage5 shots"],
    );
    runtimeId = runtime.rows[0]!.id;
    const agent = await client.query<{ id: string }>(
      `INSERT INTO agent (
         workspace_id, name, description, instructions, runtime_mode,
         runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id, thinking_level
       )
       VALUES ($1, 'Atlas', 'Stage5 evidence agent', 'Be helpful.', 'cloud',
               '{}'::jsonb, $2, 'workspace', 3, $3, 'high')
       RETURNING id::text`,
      [ws.id, runtimeId, user.rows[0]!.id],
    );
    agentId = agent.rows[0]!.id;
    await api.postJson("/api/agent-folders", { name: `Research ${STAMP}`, parent_id: "" });

    await page.goto(`/${slug}/agents`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: `Expand Research ${STAMP}` }),
    ).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(600);
    await shot(page, "03-agents-folder-tree");

    await page.locator('[role="row"]', { hasText: "Atlas" }).first().click();
      await expect(page.getByText(/thinking/i).first()).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(600);
    await shot(page, "04-agent-thinking-level");
  } finally {
    if (agentId) await client.query(`DELETE FROM agent WHERE id = $1`, [agentId]);
    if (runtimeId) await client.query(`DELETE FROM agent_runtime WHERE id = $1`, [runtimeId]);
    await client.end();
  }
});

test("05 skills folder tree", async ({ page }) => {
  await auth(page);
  const root = await api.postJson<{ id: string }>("/api/skill-folders", {
    name: `Engineering ${STAMP}`,
    parent_id: "",
  });
  const skill = await api.postJson<{ id: string }>("/api/skills", {
    name: `Alpha skill ${STAMP}`,
    description: "",
    content: `# Alpha skill ${STAMP}\n`,
    config: {},
  });
  const client = db();
  await client.connect();
  try {
    const ws = (await api.getWorkspaces())[0]!;
    await client.query(
      `INSERT INTO labrastro_skill_placement (workspace_id, skill_id, folder_id)
       VALUES ($1, $2, $3)`,
      [ws.id, skill.id, root.id],
    );
    await page.goto(`/${slug}/skills`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", { name: `Expand Engineering ${STAMP}` }),
    ).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(600);
    await shot(page, "05-skills-folder-tree");
  } finally {
    await client.end();
  }
});

test("06 skill version history tab (v0.8.1)", async ({ page }) => {
  await auth(page);
  // Reuse the workspace/skill/folder created by test 05 (serial mode, same STAMP).
  const client = db();
  await client.connect();
  let skillId = "";
  try {
    const rows = await client.query<{ id: string }>(
      `SELECT s.id::text FROM skill s WHERE s.name LIKE $1 ORDER BY s.created_at DESC LIMIT 1`,
      [`Alpha skill ${STAMP}%`],
    );
    skillId = rows.rows[0]?.id ?? "";
    if (!skillId) throw new Error("Alpha skill from step 05 not found");
  } finally {
    await client.end();
  }
  await page.goto(`/${slug}/skills/${skillId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(`Alpha skill ${STAMP}`).first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);
  await shot(page, "06-skill-detail");
  // v0.8.1 version history lives in the detail "More actions" overflow menu.
  const menuButton = page.getByRole("button", { name: "More actions", exact: true }).first();
  if (await menuButton.count()) {
    await menuButton.click();
    const item = page.getByRole("menuitem", { name: "Version history" });
    if (await item.count()) {
      await item.click();
      await page.waitForTimeout(800);
      await shot(page, "06-skill-versions-tab");
    }
  }
});

test("07 runtime quotas & concurrency", async ({ page }) => {
  await auth(page);
  const runtimeId = await api.seedRuntime(`Stage5 Quota Host ${STAMP}`);
  await page.goto(`/${slug}/runtimes/${runtimeId}`, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[role="row"]', { hasText: `Stage5 Quota Host ${STAMP}` }).first(),
  ).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);
  await shot(page, "07-runtime-quotas-detail");

  await page.goto(`/${slug}/runtimes`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "All runtimes" })).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(600);
  await shot(page, "08-runtimes-list");
});

async function setBlockedBy(id: string, blockedBy: string[]) {
  const ws = (await api.getWorkspaces())[0]!;
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:18080";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${api.getToken()}`,
    "X-Workspace-ID": ws.id,
  };
  const before = await fetch(`${base}/api/issues/${id}/dependencies`, { headers });
  const body = await before.json();
  const write = await fetch(`${base}/api/issues/${id}/with-dependencies`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      blocked_by: blockedBy,
      expected_dependency_version: body.dependency_version,
    }),
  });
  expect(write.ok, `${write.status} ${await write.text()}`).toBe(true);
}
