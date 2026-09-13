// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

// Schema-boundary tests for the OL-72 target-discovery reads (OL-74 frontend).
// Canonical parsing matrices live here; the picker components only render
// what these methods return.

afterEach(() => vi.unstubAllGlobals());
const client = new ApiClient("https://example.test");

const chat = {
  chat_id: "oc_a", name: "Release", description: "Team A",
  avatar: "", external: false, chat_status: "normal",
};
const anchor = {
  message_id: "om_new", chat_id: "oc_a", message_type: "text",
  summary: "release ready", create_time: "1700000000000",
  thread_id: "omt_topic", sender: { type: "user", id: "ou_1", id_type: "open_id" },
};

function stubFetch(body: unknown) {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body))));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("parses capabilities, chat pages and anchor pages from the wire contract", async () => {
  stubFetch({
    chat_list_supported: true, message_anchor_list_supported: true,
    region: "feishu", scope_status: "not_checked",
    max_chat_page_size: 100, max_message_page_size: 50,
  });
  const caps = await client.getLarkTargetCapabilities("ws", "inst");
  expect(caps.chat_list_supported).toBe(true);
  expect(caps.message_anchor_list_supported).toBe(true);

  stubFetch({ items: [chat], has_more: false, next_cursor: "" });
  const page = await client.listLarkTargetChats("ws", "inst", { pageSize: 20, q: "Release" });
  expect(page.items).toHaveLength(1);
  expect(page.has_more).toBe(false);

  stubFetch({ items: [anchor], has_more: true, next_cursor: "cur" });
  const anchors = await client.listLarkMessageAnchors("ws", "inst", "oc_a", { pageSize: 20 });
  expect(anchors.items[0]?.message_id).toBe("om_new");
  expect(anchors.items[0]?.sender.type).toBe("user");
  expect(anchors.next_cursor).toBe("cur");
});

it("forwards page_size/q/cursor unchanged and never constructs a cursor", async () => {
  const fetch = stubFetch({ items: [], has_more: true, next_cursor: "next" });
  await client.listLarkTargetChats("ws", "inst", { pageSize: 20, q: "Rel", cursor: "opaque.cursor" });
  const url = String(fetch.mock.calls[0]?.[0]);
  expect(url).toContain("/api/workspaces/ws/lark/installations/inst/chats?");
  expect(url).toContain("page_size=20");
  expect(url).toContain("q=Rel");
  expect(url).toContain("cursor=opaque.cursor");

  await client.listLarkTargetChats("ws", "inst", {});
  const bare = String(fetch.mock.calls[1]?.[0]);
  expect(bare).toBe("https://example.test/api/workspaces/ws/lark/installations/inst/chats");

  await client.listLarkMessageAnchors("ws", "inst", "oc_a b", { cursor: "c1" });
  const anchorUrl = String(fetch.mock.calls[2]?.[0]);
  expect(anchorUrl).toContain("/chats/oc_a%20b/message-anchors?cursor=c1");
});

it("throws on malformed pages so the picker shows its failure state instead of merging unverified rows", async () => {
  stubFetch({ items: [{ name: "no id" }], has_more: false, next_cursor: "" });
  await expect(client.listLarkTargetChats("ws", "inst")).rejects.toThrow();

  stubFetch({ items: [{ message_id: "om_x", chat_id: "oc_a" }], has_more: false, next_cursor: "" });
  await expect(client.listLarkMessageAnchors("ws", "inst", "oc_a")).rejects.toThrow();

  stubFetch({ chat_list_supported: "yes" });
  await expect(client.getLarkTargetCapabilities("ws", "inst")).rejects.toThrow();
});

it("defaults descriptive chat fields so drift degrades a row instead of failing the page", async () => {
  stubFetch({ items: [{ chat_id: "oc_min", name: "Minimal" }], has_more: false, next_cursor: "" });
  const page = await client.listLarkTargetChats("ws", "inst");
  expect(page.items[0]).toMatchObject({
    chat_id: "oc_min", name: "Minimal", description: "", avatar: "", external: false, chat_status: "",
  });
});
