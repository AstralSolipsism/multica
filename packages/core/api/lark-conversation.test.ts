// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());
const client = new ApiClient("https://example.test");

it("keeps older installations readable without enabling unadvertised conversation writes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ installations: [], configured: true }))));
  expect((await client.listLarkInstallations("ws")).conversation_supported).toBeUndefined();
});

it("rejects malformed reads and ambiguous save responses so drafts remain unsaved", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ conversation: true, installations: "broken", configured: true })))));
  await expect(client.listLarkInstallations("ws")).rejects.toThrow("could not be read");
  await expect(client.setLarkConversation("ws", "inst", [])).rejects.toThrow("Could not verify");
});

it("revokes only the chosen installation without submitting a client-selected grantor", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversation: null })));
  vi.stubGlobal("fetch", fetch);
  await client.setLarkConversation("ws", "inst", []);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/api/workspaces/ws/lark/installations/inst/conversation");
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ scope: "workspace", chats: [] });
});
