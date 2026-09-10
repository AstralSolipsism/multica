// OL-28 e2e: personal "Push to my Feishu" (notifications settings) and team
// event subscriptions (workspace Lark integration settings), against the real
// server of this checkout. Seeded rows (bot installation, member binding,
// routes, approvals, deliveries) go straight into Postgres because the Lark
// transport is intentionally unconfigured in the dev environment; every UI
// interaction (toggle, edit-save, test-send, records, retry) then exercises
// the REAL OL-27 API.

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { loginAsDefault, waitForPageText } from "./helpers";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || "8080"}`;
const SHOTS = process.env.OL28_SCREENSHOT_DIR ?? "e2e/artifacts";

interface SeedRefs {
  workspaceId: string;
  userId: string;
  agentId: string;
  installationId: string;
  personalRouteId: string;
  teamRouteId: string;
  deliveryIds: string[];
}

async function apiToken(email: string, name: string): Promise<string> {
  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  try {
    await client.query("DELETE FROM verification_code WHERE email = $1", [email]);
    const sendRes = await fetch(`${API_BASE}/auth/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!sendRes.ok) throw new Error(`send-code failed: ${sendRes.status}`);
    const result = await client.query(
      "SELECT code FROM verification_code WHERE email = $1 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [email],
    );
    const configuredDevCode = process.env.MULTICA_DEV_VERIFICATION_CODE?.trim();
    const code = configuredDevCode || result.rows[0]?.code;
    if (!code) throw new Error("No verification code found");
    const verifyRes = await fetch(`${API_BASE}/auth/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (!verifyRes.ok) throw new Error(`verify-code failed: ${verifyRes.status}`);
    const data = (await verifyRes.json()) as { token: string };
    await client.query("DELETE FROM verification_code WHERE email = $1", [email]);
    void name;
    return data.token;
  } finally {
    await client.end();
  }
}

async function seed(slug: string, token: string): Promise<SeedRefs> {
  const wsRes = await fetch(`${API_BASE}/api/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const workspaces = (await wsRes.json()) as { id: string; slug: string }[];
  const workspace = workspaces.find((w) => w.slug === slug) ?? workspaces[0];
  if (!workspace) throw new Error("workspace not found");
  const workspaceId = workspace.id;

  const meRes = await fetch(`${API_BASE}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const me = (await meRes.json()) as { id: string };
  const userId = me.id;

  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  try {
    const agentId = crypto.randomUUID();
    await client.query(
      `INSERT INTO agent (id, workspace_id, name, runtime_mode) VALUES ($1, $2, $3, 'local')`,
      [agentId, workspaceId, "Delivery Bot"],
    );
    const installationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO channel_installation
         (id, workspace_id, agent_id, channel_type, config, status, installer_user_id)
       VALUES ($1, $2, $3, 'feishu', $4::jsonb, 'active', $5)`,
      [
        installationId,
        workspaceId,
        agentId,
        JSON.stringify({
          app_id: `cli_e2e_${agentId.slice(0, 8)}`,
          app_secret_encrypted: Buffer.from("e2e-seeded-secret").toString("base64"),
          bot_open_id: "ou_bot_e2e",
          region: "feishu",
        }),
        userId,
      ],
    );
    await client.query(
      `INSERT INTO channel_user_binding
         (workspace_id, multica_user_id, installation_id, channel_type, channel_user_id)
       VALUES ($1, $2, $3, 'feishu', $4)`,
      [workspaceId, userId, installationId, "ou_e2e_user"],
    );

    const personalRouteId = crypto.randomUUID();
    await client.query(
      `INSERT INTO labrastro_message_route
         (id, workspace_id, autopilot_id, installation_id, target_type, target_user_id,
          target_key, enabled, revision, created_by, updated_by, effective_from,
          source_kind, project_id, event_types)
       VALUES ($1, $2, NULL, $3, 'member', $4, $5, true, 1, $4, $4, now() - interval '1 hour',
               'inbox', NULL, '{issue_assigned,new_comment}')`,
      [personalRouteId, workspaceId, installationId, userId, `member:${userId}`],
    );

    const teamRouteId = crypto.randomUUID();
    await client.query(
      `INSERT INTO labrastro_message_route
         (id, workspace_id, autopilot_id, installation_id, target_type, target_chat_id,
          target_key, enabled, revision, created_by, updated_by, effective_from,
          source_kind, project_id, event_types)
       VALUES ($1, $2, NULL, $3, 'group', 'oc_e2e_team', 'group:oc_e2e_team', true, 1, $4, $4,
               now() - interval '1 hour', 'activity', NULL, '{}')`,
      [teamRouteId, workspaceId, installationId, userId],
    );
    await client.query(
      `INSERT INTO labrastro_message_approved_target
         (workspace_id, autopilot_id, installation_id, target_key, target_type, approved_by,
          source_kind, project_id)
       VALUES ($1, NULL, $2, 'group:oc_e2e_team', 'group', $3, 'activity', NULL)`,
      [workspaceId, installationId, userId],
    );

    const insertDelivery = async (opts: {
      routeId: string;
      sourceKind: string;
      status: string;
      targetKey: string;
      errorCode?: string;
      receipt?: boolean;
      summary: string;
      text: string;
    }) => {
      const id = crypto.randomUUID();
      const isSent = opts.status === "sent";
      await client.query(
        `INSERT INTO labrastro_message_delivery
           (id, workspace_id, route_id, route_revision, autopilot_id, run_id, dedup_key,
            source_kind, status, attempts, error_code, content_snapshot, target_snapshot,
            installation_id, target_key, shard_total, source_ref, delivered_at, first_attempt_at,
            source_ref_id, source_scope, source_project_id)
         VALUES ($1, $2, $3, 1, NULL, NULL, $4, $5, $6, 1, $7, $8::jsonb, $9::jsonb,
                 $10, $11, 1, $12::jsonb, $13, now() - interval '5 minutes',
                 gen_random_uuid(), $5, NULL)`,
        [
          id,
          workspaceId,
          opts.routeId,
          `e2e:${id}`,
          opts.sourceKind,
          opts.status,
          opts.errorCode ?? null,
          JSON.stringify({
            summary: opts.summary,
            text: opts.text,
            source_kind: opts.sourceKind,
            link: `http://localhost:13195/${slug}/issues/OL-1`,
          }),
          JSON.stringify(
            opts.sourceKind === "inbox"
              ? {
                  target_type: "member",
                  channel_type: "feishu",
                  installation_id: installationId,
                  user_id: userId,
                  open_id: "ou_e2e_user",
                }
              : {
                  target_type: "group",
                  channel_type: "feishu",
                  installation_id: installationId,
                  chat_id: "oc_e2e_team",
                },
          ),
          installationId,
          opts.targetKey,
          JSON.stringify(
            opts.sourceKind === "inbox"
              ? { source_kind: "inbox", inbox_item_id: crypto.randomUUID(), issue_identifier: "OL-1" }
              : {
                  source_kind: "activity",
                  activity_id: crypto.randomUUID(),
                  issue_identifier: "OL-1",
                },
          ),
          isSent ? now() : null,
        ],
      );
      if (opts.receipt) {
        await client.query(
          `INSERT INTO labrastro_message_receipt
             (delivery_id, workspace_id, installation_id, shard_index, shard_total, send_uuid,
              external_message_id)
           VALUES ($1, $2, $3, 0, 1, $4, $5)`,
          [id, workspaceId, installationId, crypto.randomUUID(), "om_e2e_receipt_1"],
        );
      }
      return id;
    };

    const deliveryIds: string[] = [];
    deliveryIds.push(
      await insertDelivery({
        routeId: personalRouteId,
        sourceKind: "inbox",
        status: "sent",
        targetKey: `member:${userId}`,
        receipt: true,
        summary: "Issue assigned to you",
        text: "OL-1 Demo issue was assigned to you.",
      }),
    );
    deliveryIds.push(
      await insertDelivery({
        routeId: personalRouteId,
        sourceKind: "inbox",
        status: "failed",
        targetKey: `member:${userId}`,
        errorCode: "member_unbound",
        summary: "New comment",
        text: "New comment on OL-1.",
      }),
    );
    deliveryIds.push(
      await insertDelivery({
        routeId: teamRouteId,
        sourceKind: "activity",
        status: "uncertain",
        targetKey: "group:oc_e2e_team",
        summary: "Issue status changed",
        text: "OL-1 status changed: In Progress → In Review.",
      }),
    );

    return {
      workspaceId,
      userId,
      agentId,
      installationId,
      personalRouteId,
      teamRouteId,
      deliveryIds,
    };
  } finally {
    await client.end();
  }
}

async function cleanup(refs: SeedRefs | null) {
  if (!refs) return;
  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  try {
    await client.query(
      "DELETE FROM labrastro_message_receipt WHERE delivery_id = ANY($1::uuid[])",
      [refs.deliveryIds],
    );
    await client.query(
      "DELETE FROM labrastro_message_delivery WHERE route_id = ANY($1::uuid[]) OR id = ANY($1::uuid[])",
      [[refs.personalRouteId, refs.teamRouteId, ...refs.deliveryIds]],
    );
    // Test sends create extra deliveries keyed by route; the clause above
    // covers them via route_id. Routes themselves:
    await client.query("DELETE FROM labrastro_message_route WHERE id = ANY($1::uuid[])", [
      [refs.personalRouteId, refs.teamRouteId],
    ]);
    await client.query(
      "DELETE FROM labrastro_message_approved_target WHERE workspace_id = $1 AND installation_id = $2",
      [refs.workspaceId, refs.installationId],
    );
    await client.query(
      "DELETE FROM channel_user_binding WHERE installation_id = $1",
      [refs.installationId],
    );
    await client.query("DELETE FROM channel_installation WHERE id = $1", [refs.installationId]);
    await client.query("DELETE FROM agent WHERE id = $1", [refs.agentId]);
  } finally {
    await client.end();
  }
}

async function authedGoto(page: Page, token: string, url: string) {
  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, token);
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

test.describe("OL-28 personal Feishu push + team subscriptions", () => {
  test.describe.configure({ mode: "serial" });
  // First hit compiles the dev bundle; give the login + seed headroom.
  test.setTimeout(180_000);

  let slug = "";
  let token = "";
  let refs: SeedRefs | null = null;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    slug = await loginAsDefault(page);
    // Reuse the helper's login session shape: mint a fresh token for API/DB seeding.
    const email = `e2e-ol28-${Date.now().toString(36)}@multica.ai`;
    void email;
    const stored = await page.evaluate(() => localStorage.getItem("multica_token"));
    if (!stored) throw new Error("no token after login");
    token = stored;
    refs = await seed(slug, token);
    await page.close();
  });

  test.afterAll(async () => {
    await cleanup(refs);
  });

  test("notifications settings: personal push section states and real interactions", async ({
    page,
  }) => {
    await authedGoto(page, token, `/${slug}/settings?tab=notifications`);
    await waitForPageText(page, "Push to my Feishu", 60000);

    // Route row with the honest self-DM target, event filter summary and hints.
    await waitForPageText(page, "Your Feishu DM", 60000);
    await waitForPageText(page, "2 events", 60000);
    await waitForPageText(
      page,
      "Notification categories muted above are not forwarded to Feishu.",
    );
    await waitForPageText(page, "Delivery Bot", 60000);
    await page.screenshot({
      path: `${SHOTS}/ol28-notifications-personal.png`,
      fullPage: true,
    });

    // Disable → enable via the real enable API (revision-guarded). The route
    // switch is the one labelled with the source kind (the category mutes
    // above are separate switches).
    const toggle = page.getByRole("switch", { name: "Personal notifications" });
    await toggle.click();
    await waitForPageText(page, "Push target disabled", 60000);
    await toggle.click();
    await waitForPageText(page, "Push target enabled", 60000);

    // Records: seeded sent/failed rows from the real records API. Done
    // BEFORE the test-send below so the only "Failed" row is the seeded one.
    await page.getByRole("button", { name: "Records" }).first().click();
    await waitForPageText(page, "Deliveries for this rule", 60000);
    await waitForPageText(page, "Failed", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-personal-records.png` });

    // Detail of the failed row shows the frozen error reason.
    await page.getByText("Failed", { exact: true }).first().click();
    await waitForPageText(page, "Delivery detail", 60000);
    await waitForPageText(page, "The member's Feishu binding was removed", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-personal-delivery-detail.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Test-send runs the REAL path; with an unreachable seeded bot the
    // outcome is a real failure status, never a simulated success.
    await page.getByRole("button", { name: "Send test" }).click();
    await waitForPageText(page, "Test message", 60000);

    // Edit dialog: self-target is fixed, event filter comes from the catalog.
    await page.getByRole("button", { name: "Edit" }).first().click();
    await waitForPageText(page, "Edit Feishu push", 60000);
    await waitForPageText(
      page,
      "the recipient is always you and can't be changed",
    );
    await waitForPageText(page, "Issue assigned to you", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-personal-editor.png` });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await waitForPageText(page, "Push target saved", 60000);
  });

  test("integrations settings: team subscriptions, approvals and editor approval hint", async ({
    page,
  }) => {
    await authedGoto(
      page,
      token,
      `/${slug}/settings?tab=integrations&integration=lark`,
    );
    await waitForPageText(page, "Team event subscriptions", 60000);
    await waitForPageText(page, "oc_e2e_team", 60000);
    await waitForPageText(page, "Whole workspace", 60000);
    // innerText reflects the CSS uppercase transform of this heading.
    await waitForPageText(page, "APPROVED TEAM TARGETS", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-team-subscriptions.png`, fullPage: true });

    // The team records dialog shows the seeded uncertain delivery.
    await page.getByRole("button", { name: "Records" }).first().click();
    await waitForPageText(page, "Deliveries for this rule", 60000);
    await waitForPageText(page, "Uncertain", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-team-records.png` });

    // Uncertain retry requires the explicit verify-first confirm.
    await page.getByText("Uncertain", { exact: true }).first().click();
    await waitForPageText(page, "Delivery detail", 60000);
    await page.getByRole("button", { name: "Retry" }).click();
    await waitForPageText(page, "Verify before retrying", 60000);
    await page.getByRole("button", { name: "Checked — retry" }).click();
    await waitForPageText(page, "Delivery re-queued", 60000);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Add-subscription editor: group target without a matching approval shows
    // the approve-then-save state (this user is the workspace owner).
    await page.getByRole("button", { name: "Add subscription" }).click();
    await waitForPageText(page, "Add subscription", 60000);
    await page.locator("input.font-mono").first().fill("oc_new_chat");
    await waitForPageText(page, "isn't approved for this source and scope yet", 60000);
    await waitForPageText(page, "Approve and save", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-team-editor.png` });
  });

  test("narrow viewport keeps the personal section usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await authedGoto(page, token, `/${slug}/settings?tab=notifications`);
    await waitForPageText(page, "Push to my Feishu", 60000);
    await waitForPageText(page, "Your Feishu DM", 60000);
    await page.screenshot({ path: `${SHOTS}/ol28-notifications-narrow.png`, fullPage: true });
  });
});

// `now()` helper kept tiny and local so the seed SQL stays readable.
function now() {
  return new Date();
}
