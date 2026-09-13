// OL-74 e2e: Lark target pickers — group and message-anchor picking for the
// push editors, and the conversation-grant multi-select — against the real
// server of this checkout. Only the OL-72 discovery READS are route-mocked:
// the dev transport is the stub, so unmocked they would answer 503
// (lark_discovery_unsupported) and we would screenshot the fallback, not the
// picker. The conversation-grant SAVE itself hits the real API (PUT
// .../conversation), proving the picked IDs flow into the existing grant
// path unchanged.

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { loginAsDefault, waitForPageText } from "./helpers";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";
const SHOTS = process.env.OL74_SCREENSHOT_DIR ?? "e2e/artifacts";

interface SeedRefs {
  workspaceId: string;
  agentId: string;
  installationId: string;
}

const CHATS_PAGE_1 = {
  items: [
    { chat_id: "oc_release_a", name: "Release", description: "Team A", avatar: "", external: false, chat_status: "normal" },
    { chat_id: "oc_release_b", name: "Release", description: "Team B", avatar: "", external: true, chat_status: "normal" },
    { chat_id: "oc_alerts", name: "Alerts", description: "Paging channel", avatar: "", external: false, chat_status: "normal" },
  ],
  has_more: true,
  next_cursor: "e2e-page-2",
};
const CHATS_PAGE_2 = {
  items: [
    { chat_id: "oc_random", name: "Random", description: "", avatar: "", external: false, chat_status: "normal" },
  ],
  has_more: false,
  next_cursor: "",
};
const ANCHORS = {
  items: [
    {
      message_id: "om_anchor_new", chat_id: "oc_release_a", message_type: "text",
      summary: "v2.4 rollout starts Thursday — thread for status updates",
      create_time: "1780000000000", thread_id: "omt_rollout",
      sender: { type: "user", id: "ou_alice123456", id_type: "open_id" },
    },
    {
      message_id: "om_anchor_old", chat_id: "oc_release_a", message_type: "text",
      summary: "[Image]",
      create_time: "1779900000000",
      sender: { type: "anonymous" },
    },
  ],
  has_more: false,
  next_cursor: "",
};

/** Route-mock ONLY the discovery reads; everything else (installations list,
 * conversation save, catalogs) goes to the real server of this checkout. */
async function mockDiscovery(page: Page, mode: "ok" | "permission_denied" | "old_server") {
  await page.route(
    /\/api\/workspaces\/[^/]+\/lark\/installations\/[^/]+\/(target-capabilities|chats)/,
    (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (mode === "old_server") {
        return route.fulfill({ status: 404, contentType: "text/plain", body: "404 page not found" });
      }
      if (path.endsWith("/target-capabilities")) {
        return route.fulfill({
          json: {
            chat_list_supported: true,
            message_anchor_list_supported: true,
            region: "feishu",
            scope_status: "not_checked",
            max_chat_page_size: 100,
            max_message_page_size: 50,
          },
        });
      }
      if (mode === "permission_denied") {
        return route.fulfill({
          status: 403,
          json: { error: "check bot scopes", code: "lark_discovery_permission_denied" },
        });
      }
      if (path.endsWith("/message-anchors")) {
        return route.fulfill({ json: ANCHORS });
      }
      if (path.endsWith("/chats")) {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const cursor = url.searchParams.get("cursor") ?? "";
        const src = cursor === "e2e-page-2" ? CHATS_PAGE_2 : CHATS_PAGE_1;
        const items = q === "" ? src.items : src.items.filter((c) => c.name.toLowerCase().includes(q));
        // A filtered page may be empty while has_more stays true — the UI
        // must keep paging before it may say "no matches" (contract).
        return route.fulfill({
          json: { items, has_more: src.has_more, next_cursor: src.has_more ? src.next_cursor : "" },
        });
      }
      return route.continue();
    },
  );
}

async function seed(token: string): Promise<SeedRefs> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT || "8080"}`;
  const wsRes = await fetch(`${apiBase}/api/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const workspaces = (await wsRes.json()) as { id: string; slug: string }[];
  const workspace = workspaces[0];
  if (!workspace) throw new Error("workspace not found");
  const meRes = await fetch(`${apiBase}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  const me = (await meRes.json()) as { id: string };

  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  try {
    const agentId = crypto.randomUUID();
    await client.query(
      `INSERT INTO agent (id, workspace_id, name, runtime_mode, owner_id) VALUES ($1, $2, $3, 'local', $4)`,
      [agentId, workspace.id, "OL74 Bot", me.id],
    );
    const installationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO channel_installation
         (id, workspace_id, agent_id, channel_type, config, status, installer_user_id)
       VALUES ($1, $2, $3, 'feishu', $4::jsonb, 'active', $5)`,
      [
        installationId,
        workspace.id,
        agentId,
        JSON.stringify({
          app_id: `cli_e2e_${agentId.slice(0, 8)}`,
          app_secret_encrypted: Buffer.from("e2e-seeded-secret").toString("base64"),
          bot_open_id: "ou_bot_e2e",
          region: "feishu",
        }),
        me.id,
      ],
    );
    return { workspaceId: workspace.id, agentId, installationId };
  } finally {
    await client.end();
  }
}

async function cleanup(refs: SeedRefs | null) {
  if (!refs) return;
  const client = new pg.Client(DATABASE_URL);
  await client.connect();
  try {
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

test.describe("OL-74 Lark target pickers", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let slug = "";
  let token = "";
  let refs: SeedRefs | null = null;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    slug = await loginAsDefault(page);
    const stored = await page.evaluate(() => localStorage.getItem("multica_token"));
    if (!stored) throw new Error("no token after login");
    token = stored;
    refs = await seed(token);
    await page.close();
  });

  test.afterAll(async () => {
    await cleanup(refs);
  });

  test("conversation grant: groups picked from the joined-group list, saved through the real API", async ({ page }) => {
    await mockDiscovery(page, "ok");
    await authedGoto(page, token, `/${slug}/settings?tab=integrations&integration=lark`);
    await waitForPageText(page, "Connected bots", 60000);

    await page.getByText("Agent conversations").click();
    await page.getByRole("button", { name: /Add groups/ }).click();
    await waitForPageText(page, "Team A", 30000);
    // Same-name groups are distinguished by description, external badge and ID suffix.
    await waitForPageText(page, "Team B", 30000);
    await waitForPageText(page, "External", 30000);
    await page.screenshot({ path: `${SHOTS}/ol74-conversation-picker.png` });

    // Name search goes to the (mocked) server one provider page at a time;
    // paging continues past empty filtered pages.
    await page.getByLabel("Search groups").fill("Random");
    await waitForPageText(page, "Random", 30000);
    expect(await page.getByRole("checkbox", { name: /Team A/ }).count()).toBe(0);

    await page.getByLabel("Search groups").fill("");
    await page.getByRole("checkbox", { name: /Team A/ }).click();
    await page.getByRole("checkbox", { name: /Alerts/ }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await page.screenshot({ path: `${SHOTS}/ol74-conversation-selected.png` });

    // The save hits the REAL grant endpoint with the picked IDs.
    await page.getByRole("button", { name: "Authorize conversations" }).click();
    await waitForPageText(page, "Conversation authorization saved.", 30000);
  });

  test("team subscription editor: group then anchor, approve-and-save state", async ({ page }) => {
    await mockDiscovery(page, "ok");
    await authedGoto(page, token, `/${slug}/settings?tab=integrations&integration=lark`);
    await waitForPageText(page, "Team event subscriptions", 60000);

    await page.getByRole("button", { name: "Add subscription" }).click();
    await waitForPageText(page, "Add subscription", 60000);

    // Group target: pick from the list, no raw oc_ typing.
    await waitForPageText(page, "Team A", 30000);
    await page.getByRole("option", { name: /Team A/ }).click();
    await waitForPageText(page, "Selected group", 30000);
    await page.screenshot({ path: `${SHOTS}/ol74-editor-group-picked.png` });

    // Topic target: the anchor picker lists recent messages of the picked group.
    await page.getByRole("combobox", { name: /^Target$/ }).click();
    await page.getByRole("option", { name: "Topic" }).click();
    await waitForPageText(page, "v2.4 rollout starts Thursday", 30000);
    await page.getByRole("option", { name: /v2\.4 rollout/ }).click();
    await waitForPageText(page, "Selected anchor", 30000);
    await waitForPageText(page, "Approve and save", 30000);
    await page.screenshot({ path: `${SHOTS}/ol74-editor-topic-picked.png` });
    // The save would run the REAL live-target verification, which the stub
    // transport cannot pass — the approve-and-save STATE is the evidence here;
    // the payload threading is covered by the component suites.
  });

  test("discovery error states: permission denial and pre-discovery server", async ({ page }) => {
    await mockDiscovery(page, "permission_denied");
    await authedGoto(page, token, `/${slug}/settings?tab=integrations&integration=lark`);
    await waitForPageText(page, "Team event subscriptions", 60000);
    await page.getByRole("button", { name: "Add subscription" }).click();
    await waitForPageText(page, "Add subscription", 60000);
    await waitForPageText(page, "missing the group or message read scope", 30000);
    await page.screenshot({ path: `${SHOTS}/ol74-editor-permission-denied.png` });
    await page.keyboard.press("Escape");

    // Reload so the capabilities query refetches against the "old server"
    // (the in-page cache is legitimately fresh within its staleTime).
    await mockDiscovery(page, "old_server");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPageText(page, "Team event subscriptions", 60000);
    await page.getByRole("button", { name: "Add subscription" }).click();
    await waitForPageText(page, "Add subscription", 60000);
    // Fallback: manual oc_ entry, exactly the pre-OL-74 path.
    await waitForPageText(page, "cannot browse groups or messages yet", 30000);
    await page.locator("input.font-mono").first().fill("oc_manual_fallback");
    await page.screenshot({ path: `${SHOTS}/ol74-editor-fallback.png` });
  });
});
