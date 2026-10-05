// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { isEditableLarkConversation } from "../lark/schema";

afterEach(() => vi.unstubAllGlobals());
const client = new ApiClient("https://example.test");

const grant = {
  id: "00000000-0000-4000-8000-000000000001",
  authorized_by: "00000000-0000-4000-8000-000000000002",
  scope: "workspace",
  chats: [{ chat_id: "oc_group", chat_type: "group" }],
};

it.each([
  { ...grant, scope: "future_scope" },
  { ...grant, chats: [...grant.chats, { chat_id: "oc_future", chat_type: "future_type" }] },
  { ...grant, chats: [...grant.chats, null] },
  { ...grant, chats: "broken" },
  { ...grant, id: "future-id-format" },
  { ...grant, authorized_by: "future-actor-format" },
  true,
])("isolates an unreadable conversation without losing installations: %j", async (conversation) => {
  const installation = {
    id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "cli_test",
    bot_open_id: "ou_bot", installer_user_id: "user", status: "active",
    installed_at: "", created_at: "", updated_at: "",
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    installations: [
      { ...installation, conversation },
      { ...installation, id: "other", conversation: grant },
    ],
    configured: true, conversation_supported: true,
  }))));
  const result = await client.listLarkInstallations("ws");
  expect(result.installations.map((item) => item.id)).toEqual(["inst", "other"]);
  expect(isEditableLarkConversation(result.installations[0]?.conversation)).toBe(false);
  expect(result.installations[1]?.conversation).toEqual(grant);
  expect(isEditableLarkConversation(result.installations[1]?.conversation)).toBe(true);
});

it("marks unknown scope and chat kinds explicitly unreadable", async () => {
  const { LarkInstallationsSchema } = await import("../lark/schema");
  const parsed = LarkInstallationsSchema.parse({
    installations: [{
      id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app",
      bot_open_id: "bot", installer_user_id: "user", status: "active",
      installed_at: "", created_at: "", updated_at: "",
      conversation: { ...grant, scope: "future", chats: [{ chat_id: "oc_future", chat_type: "future" }] },
    }], configured: true,
  });
  expect(parsed.installations[0]?.conversation).toMatchObject({
    scope: "unreadable", chats: [{ chat_id: "oc_future", chat_type: "unreadable" }],
  });
});

it.each([null, undefined])("treats %j as no conversation grant", (conversation) => {
  expect(isEditableLarkConversation(conversation)).toBe(true);
});

it("allows the server's omitted conversation field when conversation authorization is supported", async () => {
  const installation = {
    id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app",
    bot_open_id: "bot", installer_user_id: "user", status: "active",
    installed_at: "", created_at: "", updated_at: "",
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    installations: [installation], configured: true, conversation_supported: true,
  }))));
  const result = await client.listLarkInstallations("ws");
  expect(result.conversation_supported).toBe(true);
  expect(result.installations[0]).not.toHaveProperty("conversation");
  expect(isEditableLarkConversation(result.installations[0]?.conversation)).toBe(true);
});

it("keeps older installations readable without enabling unadvertised conversation writes", async () => {
  const installation = {
    id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "cli_test",
    bot_open_id: "ou_bot", installer_user_id: "user", status: "active", region: "feishu",
    installed_at: "2026-09-10T00:00:00Z", created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ installations: [installation], configured: true }))));
  const result = await client.listLarkInstallations("ws");
  expect(result.installations).toEqual([installation]);
  expect(result.conversation_supported).toBeUndefined();
});

it("rejects malformed reads and ambiguous save responses so drafts remain unsaved", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ conversation: true, installations: "broken", configured: true })))));
  await expect(client.listLarkInstallations("ws")).rejects.toMatchObject({ body: { code: "response_unreadable" } });
  await expect(client.setLarkConversation("ws", "inst", [])).rejects.toMatchObject({ body: { code: "response_unconfirmed" } });
});

it("revokes only the chosen installation without submitting a client-selected grantor", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversation: null })));
  vi.stubGlobal("fetch", fetch);
  await client.setLarkConversation("ws", "inst", []);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/api/workspaces/ws/lark/installations/inst/conversation");
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ scope: "workspace", chats: [] });
});
