// @vitest-environment jsdom
// Temporary review regressions; no production changes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { larkInstallationsOptions, larkKeys } from "@multica/core/lark";
import type { LarkConversationGrant, LarkInstallation, ListLarkInstallationsResponse } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { LarkConversationForm } from "./lark-conversation-form";

const calls = vi.hoisted(() => ({
  installations: vi.fn(), caps: vi.fn(), groups: vi.fn(), candidates: vi.fn(), confirm: vi.fn(), save: vi.fn(),
}));
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api,
    listLarkInstallations: (...args: unknown[]) => calls.installations(...args),
    getLarkTargetCapabilities: (...args: unknown[]) => calls.caps(...args),
    listLarkTargetChats: (...args: unknown[]) => calls.groups(...args),
    listLarkPrivateChatCandidates: (...args: unknown[]) => calls.candidates(...args),
    confirmLarkPrivateChatCandidates: (...args: unknown[]) => calls.confirm(...args),
    setLarkConversation: (...args: unknown[]) => calls.save(...args),
  } };
});

const initial: LarkInstallation = {
  id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app", bot_open_id: "bot",
  installer_user_id: "owner", status: "active", installed_at: "", created_at: "", updated_at: "",
  conversation: { id: "old", authorized_by: "owner", scope: "workspace", chats: [
    { chat_id: "oc_group", chat_type: "group" }, { chat_id: "oc_previously_revoked", chat_type: "p2p" },
  ] },
};
const confirmed: LarkConversationGrant = {
  id: "new", authorized_by: "owner", scope: "workspace", chats: [
    { chat_id: "oc_group", chat_type: "group" },
    { chat_id: "oc_added_elsewhere", chat_type: "p2p" },
    { chat_id: "oc_alice", chat_type: "p2p" },
  ],
};
const alice = {
  id: "candidate-alice", chat_id: "oc_alice", chat_type: "p2p",
  sender: { type: "user", id: "ou_alice", id_type: "open_id" },
  display_name: "Alice", identity_status: "name_available", authorization_status: "pending",
  first_seen_at: "2026-09-13T12:00:00Z", last_seen_at: "2026-09-13T12:00:00Z", expires_at: "2026-09-20T12:00:00Z",
};
function Harness() {
  const { data } = useQuery(larkInstallationsOptions("ws"));
  const inst = data?.installations[0];
  return inst ? <LarkConversationForm workspaceId="ws" installation={inst} disabled={false} /> : null;
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
  return qc;
}
beforeEach(() => {
  for (const mock of Object.values(calls)) mock.mockReset();
  calls.installations.mockResolvedValue({ installations: [initial], configured: true });
  calls.caps.mockResolvedValue({ chat_list_supported: true, message_anchor_list_supported: true,
    region: "feishu", scope_status: "not_checked", max_chat_page_size: 100, max_message_page_size: 50,
    private_chat_candidates_supported: true,
  });
  calls.groups.mockResolvedValue({ items: [], has_more: false, next_cursor: "" });
  calls.candidates.mockResolvedValue({ items: [alice], max_candidates: 50, retention_seconds: 604800 });
  calls.confirm.mockResolvedValue(confirmed);
  calls.save.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

it("preserves the returned complete grant in the next full-list save", async () => {
  const qc = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByText("Agent conversations"));
  await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
  await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));
  await screen.findByText(/Authorization saved/);
  expect(qc.getQueryData<ListLarkInstallationsResponse>(larkKeys.installations("ws"))?.installations[0]?.conversation).toEqual(confirmed);
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
  expect(calls.save.mock.calls[0]?.[2]).toEqual(confirmed.chats);
});

it("blocks full-list save and revoke while candidate confirmation is pending", async () => {
  let resolveConfirm!: (grant: LarkConversationGrant) => void;
  calls.confirm.mockImplementation(() => new Promise<LarkConversationGrant>((resolve) => { resolveConfirm = resolve; }));
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByText("Agent conversations"));
  await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
  await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));
  await waitFor(() => expect(calls.confirm).toHaveBeenCalledTimes(1));
  try {
    expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke conversations" })).toBeDisabled();
  } finally {
    await act(async () => resolveConfirm(confirmed));
  }
});

it("frees the selection slot when a refreshed candidate no longer exists", async () => {
  calls.installations.mockResolvedValue({ configured: true, installations: [{ ...initial,
    conversation: { ...initial.conversation, chats: Array.from({ length: 49 }, (_, i) => ({
      chat_id: `oc_group_${i}`, chat_type: "group",
    })) },
  }] });
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByText("Agent conversations"));
  await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
  calls.candidates.mockResolvedValue({ items: [{ ...alice,
    id: "candidate-bob", chat_id: "oc_bob", display_name: "Bob",
  }], max_candidates: 50, retention_seconds: 604800 });
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  const bob = await screen.findByRole("checkbox", { name: /Bob/ });
  expect(screen.queryByRole("checkbox", { name: /Alice/ })).not.toBeInTheDocument();
  expect(bob).toBeEnabled();
  expect(screen.getByRole("button", { name: /Authorize selected \(0\)/ })).toBeDisabled();
});

it("does not let a late installation GET replace a completed confirmation", async () => {
  // Match the production parent: background installation reads disable the
  // form, but can start while the confirmation POST is already in flight.
  function RefreshAwareHarness() {
    const { data, isFetching, isError } = useQuery(larkInstallationsOptions("ws"));
    const inst = data?.installations[0];
    return inst ? <LarkConversationForm workspaceId="ws" installation={inst} disabled={isFetching || isError} /> : null;
  }
  let resolveConfirm!: (grant: LarkConversationGrant) => void;
  let resolveRead!: (listing: ListLarkInstallationsResponse) => void;
  const grantAfterConfirm: LarkConversationGrant = { ...confirmed, chats: [
    ...(initial.conversation?.chats ?? []), { chat_id: "oc_alice", chat_type: "p2p" },
  ] };
  calls.confirm.mockImplementation(() => new Promise<LarkConversationGrant>((resolve) => { resolveConfirm = resolve; }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(<QueryClientProvider client={qc}><RefreshAwareHarness /></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByText("Agent conversations"));
  await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
  await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));
  await waitFor(() => expect(calls.confirm).toHaveBeenCalledTimes(1));

  // A WS invalidation starts a read before the POST commits; its response
  // holds the old snapshot until after the confirmation response arrives.
  calls.installations.mockImplementationOnce(() => new Promise<ListLarkInstallationsResponse>((resolve) => { resolveRead = resolve; }));
  let refresh!: Promise<void>;
  await act(async () => { refresh = qc.invalidateQueries({ queryKey: larkKeys.installations("ws") }); });
  await waitFor(() => expect(calls.installations).toHaveBeenCalledTimes(2));
  await act(async () => resolveConfirm(grantAfterConfirm));
  await waitFor(() => expect(qc.getQueryData<ListLarkInstallationsResponse>(larkKeys.installations("ws"))?.installations[0]?.conversation).toEqual(grantAfterConfirm));
  await screen.findByRole("button", { name: /remove Alice/i });

  await act(async () => {
    resolveRead({ installations: [initial], configured: true });
    await refresh;
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
  expect(calls.save.mock.calls[0]?.[2]).toEqual(grantAfterConfirm.chats);
});
