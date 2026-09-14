import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { TestApiClient } from "./fixtures";

// OL-78: webhook filter bring-in + match preview from a stored delivery.
//
// Everything runs against the real backend: the delivery is ingested through
// the actual webhook endpoint, the suggestion and the match verdicts come from
// the server's own matcher, and the save goes through the trigger PATCH. The
// spec ends by re-firing the same webhook to prove the saved filter admits
// what the preview promised.

const E2E_RUN_ID =
  process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const EMAIL = `e2e-ol78-${E2E_RUN_ID}@multica.ai`;
const NAME = "E2E OL78 User";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || "8080"}`;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

interface Seed {
  slug: string;
  autopilotId: string;
  webhookPath: string;
  token: string;
}

async function seed(page: Page): Promise<Seed> {
  const api = new TestApiClient();
  const data = await api.login(EMAIL, NAME);
  const userId: string | undefined = data?.user?.id;
  if (!userId) throw new Error("login did not return a user id");
  const workspace = await api.ensureWorkspace(
    `E2E OL78 WS ${E2E_RUN_ID}`,
    `e2e-ol78-${E2E_RUN_ID}`,
  );
  await api.markUserOnboarded();
  const token = api.getToken();
  if (!token) throw new Error("login did not return a token");

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Workspace-Slug": workspace.slug,
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };

  // Agents bind to a runtime, and runtimes are normally registered by a live
  // daemon — seed a workspace-visible row directly instead.
  const pgClient = new pg.Client(DATABASE_URL);
  await pgClient.connect();
  let runtimeId: string;
  try {
    const result = await pgClient.query(
      `INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, visibility, owner_id)
       VALUES ($1, $2, 'local', 'local', 'online', 'public', $3) RETURNING id`,
      [workspace.id, `ol78-runtime-${E2E_RUN_ID}`, userId],
    );
    runtimeId = result.rows[0].id;
  } finally {
    await pgClient.end();
  }

  const agent = await post("/api/agents", {
    name: "ol78-agent",
    runtime_id: runtimeId,
    instructions: "e2e",
  });
  const autopilot = await post("/api/autopilots", {
    title: "OL78 filter bring-in",
    assignee_type: "agent",
    assignee_id: agent.id,
    execution_mode: "run_only",
  });
  // A saved filter that deliberately does NOT match the delivery below.
  const trigger = await post(`/api/autopilots/${autopilot.id}/triggers`, {
    kind: "webhook",
    event_filters: [{ event: "push", actions: ["created"] }],
  });

  // Fire the real webhook ingress: GitHub workflow_run completed/success.
  const hook = await fetch(`${API_BASE}${trigger.webhook_path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-GitHub-Delivery": `ol78-e2e-${E2E_RUN_ID}-1`,
    },
    body: JSON.stringify({
      action: "completed",
      conclusion: "success",
      workflow_run: { id: 1 },
    }),
  });
  const hookBody = await hook.json();
  if (hookBody.status !== "ignored" || hookBody.reason !== "event_filtered") {
    throw new Error(`expected the seed delivery to be filtered out, got ${JSON.stringify(hookBody)}`);
  }

  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, token);

  return {
    slug: workspace.slug,
    autopilotId: autopilot.id,
    webhookPath: trigger.webhook_path,
    token,
  };
}

test("OL-78: derive a filter from a delivery, preview the match, save it", async ({
  page,
}) => {
  const seeded = await seed(page);

  await page.goto(`/${seeded.slug}/autopilots/${seeded.autopilotId}`);

  // Open the delivery detail dialog from the deliveries list.
  await page.getByText("github.workflow_run.completed").first().click();

  // Suggestion card derived by the server from the stored payload.
  await expect(page.getByText("Suggested condition")).toBeVisible();
  await expect(
    page.locator("code", { hasText: "completed" }).first(),
  ).toBeVisible();
  // The saved filter (push/created) does not cover this delivery.
  await expect(
    page.getByText("This delivery would be filtered out"),
  ).toBeVisible();

  // Bring the suggestion into the draft — nothing is saved yet.
  await page
    .getByRole("button", { name: "Create filter from this delivery" })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove filter" }),
  ).toHaveCount(2);
  // Live preview of the merged draft flips to accepted (real server verdict).
  await expect(
    page.getByText("This delivery would be accepted"),
  ).toBeVisible();

  // The close guard treats the unsaved draft explicitly.
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("Discard unsaved filter changes?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(
    page.getByText("Discard unsaved filter changes?"),
  ).not.toBeVisible();

  // Save persists through the real trigger PATCH.
  await page.getByRole("button", { name: "Save filters" }).click();
  await expect(page.getByText("Event filters saved")).toBeVisible();
  // Back in read mode, the saved filters now accept this delivery.
  await expect(
    page.getByText("This delivery would be accepted"),
  ).toBeVisible();

  // The saved filter really admits the same event now — the preview and the
  // post-save matcher agree, end to end.
  const refire = await fetch(`${API_BASE}${seeded.webhookPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-GitHub-Delivery": `ol78-e2e-${E2E_RUN_ID}-2`,
    },
    body: JSON.stringify({
      action: "completed",
      conclusion: "success",
      workflow_run: { id: 2 },
    }),
  });
  const refireBody = await refire.json();
  expect(refireBody.status).toBe("accepted");
});
