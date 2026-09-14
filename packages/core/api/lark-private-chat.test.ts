// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

// Schema-boundary tests for the OL-75 private-chat discovery reads and the
// confirmation write (OL-76 frontend). Canonical parsing matrices live here;
// the picker components only render what these methods return.

afterEach(() => vi.unstubAllGlobals());
const client = new ApiClient("https://example.test");

const candidate = {
  id: "01994566-7cc0-7000-8000-000000000001",
  chat_id: "oc_private_alice",
  chat_type: "p2p",
  sender: { type: "user", id: "ou_alice", id_type: "open_id" },
  display_name: "Alice",
  identity_status: "name_available",
  authorization_status: "pending",
  first_seen_at: "2026-09-13T12:00:00Z",
  last_seen_at: "2026-09-13T12:00:00Z",
  expires_at: "2026-09-20T12:00:00Z",
};

const grant = {
  id: "01994566-7cc0-7000-8000-0000000000ff",
  authorized_by: "01994566-7cc0-7000-8000-0000000000ee",
  scope: "workspace",
  chats: [{ chat_id: "oc_private_alice", chat_type: "p2p" }],
};

function stubFetch(body: unknown) {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body))));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("parses the candidate list from the wire contract", async () => {
  stubFetch({ items: [candidate], max_candidates: 50, retention_seconds: 604800 });
  const list = await client.listLarkPrivateChatCandidates("ws", "inst");
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({
    id: candidate.id,
    chat_id: "oc_private_alice",
    display_name: "Alice",
    identity_status: "name_available",
    authorization_status: "pending",
  });
  expect(list.items[0]?.sender).toMatchObject({ type: "user", id: "ou_alice", id_type: "open_id" });
  expect(list.max_candidates).toBe(50);
  expect(list.retention_seconds).toBe(604800);
});

it("defaults descriptive candidate fields so drift degrades a row instead of failing the list", async () => {
  stubFetch({
    items: [{ id: candidate.id, chat_id: "oc_min" }],
    max_candidates: 50,
    retention_seconds: 604800,
  });
  const list = await client.listLarkPrivateChatCandidates("ws", "inst");
  expect(list.items[0]).toMatchObject({
    id: candidate.id,
    chat_id: "oc_min",
    chat_type: "p2p",
    display_name: "",
    identity_status: "id_only",
    authorization_status: "pending",
    first_seen_at: "",
    last_seen_at: "",
    expires_at: "",
  });
  expect(list.items[0]?.sender.id).toBeUndefined();
});

it("throws on candidates without identity fields so the picker shows its failure state", async () => {
  stubFetch({ items: [{ display_name: "no ids" }], max_candidates: 50, retention_seconds: 604800 });
  await expect(client.listLarkPrivateChatCandidates("ws", "inst")).rejects.toThrow();

  stubFetch({ max_candidates: "fifty" });
  await expect(client.listLarkPrivateChatCandidates("ws", "inst")).rejects.toThrow();
});

it("confirms candidates with the contract body and returns the saved grant", async () => {
  const fetch = stubFetch({ conversation: grant });
  const saved = await client.confirmLarkPrivateChatCandidates("ws", "inst", [candidate.id]);

  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://example.test/api/workspaces/ws/lark/installations/inst/private-chat-candidates/confirm");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    scope: "workspace",
    candidate_ids: [candidate.id],
  });
  // Never a client-constructed chat/sender pair — only candidate UUIDs.
  expect(String(init.body)).not.toContain("oc_");
  expect(String(init.body)).not.toContain("ou_");
  expect(saved).toMatchObject({ id: grant.id, scope: "workspace" });
});

it("throws on an unverifiable confirmation response instead of guessing the saved state", async () => {
  stubFetch({ conversation: { id: "not-a-grant" } });
  await expect(client.confirmLarkPrivateChatCandidates("ws", "inst", [candidate.id])).rejects.toThrow();
});

it("reads the OL-75 capability fields and tolerates their absence on older servers", async () => {
  stubFetch({
    chat_list_supported: true, message_anchor_list_supported: true,
    region: "feishu", scope_status: "not_checked",
    max_chat_page_size: 100, max_message_page_size: 50,
    private_chat_candidates_supported: true,
    private_chat_identity_lookup_supported: false,
    max_private_chat_candidates: 50,
    private_chat_candidate_retention_seconds: 604800,
  });
  const caps = await client.getLarkTargetCapabilities("ws", "inst");
  expect(caps.private_chat_candidates_supported).toBe(true);
  expect(caps.private_chat_identity_lookup_supported).toBe(false);
  expect(caps.max_private_chat_candidates).toBe(50);

  stubFetch({
    chat_list_supported: true, message_anchor_list_supported: true,
    region: "feishu", scope_status: "not_checked",
    max_chat_page_size: 100, max_message_page_size: 50,
  });
  const old = await client.getLarkTargetCapabilities("ws", "inst");
  expect(old.private_chat_candidates_supported).toBeUndefined();
});
