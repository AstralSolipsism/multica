// @vitest-environment jsdom

import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { larkInstallationsOptions, larkKeys } from "@multica/core/lark";
import { ApiClient } from "@multica/core/api/client";
import type { LarkInstallation } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { LarkConversationForm } from "./lark-conversation-form";

const mutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
  error: new Error("failed"),
}));
vi.mock("@multica/core/lark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/lark")>();
  return { ...actual, useSetLarkConversation: () => mutation };
});

const capsMock = vi.hoisted(() => vi.fn());
const chatsMock = vi.hoisted(() => vi.fn());
const candidatesMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const installationsMock = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getLarkTargetCapabilities: (...args: unknown[]) => capsMock(...args),
      listLarkTargetChats: (...args: unknown[]) => chatsMock(...args),
      listLarkPrivateChatCandidates: (...args: unknown[]) => candidatesMock(...args),
      confirmLarkPrivateChatCandidates: (...args: unknown[]) => confirmMock(...args),
      listLarkInstallations: (...args: unknown[]) => installationsMock(...args),
    },
  };
});

const CAPS = {
  chat_list_supported: true,
  message_anchor_list_supported: true,
  region: "feishu",
  scope_status: "not_checked",
  max_chat_page_size: 100,
  max_message_page_size: 50,
};

const PRIVATE_CAPS = {
  ...CAPS,
  private_chat_candidates_supported: true,
  private_chat_identity_lookup_supported: true,
  max_private_chat_candidates: 50,
  private_chat_candidate_retention_seconds: 604800,
};

const installation: LarkInstallation = {
  id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app",
  bot_open_id: "bot", installer_user_id: "owner", status: "active",
  installed_at: "", created_at: "", updated_at: "",
};

function view(disabled: boolean, inst: LarkInstallation = installation) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <LarkConversationForm workspaceId="ws" installation={inst} disabled={disabled} />
    </QueryClientProvider>
  );
}

// Mirrors production: both call sites feed the form from the live
// installations query, so the confirm mutation's cache write flows back in
// as props and the draft re-baselines from the returned grant.
function QueryDrivenForm() {
  const { data, isError, isFetching } = useQuery(larkInstallationsOptions("ws"));
  const inst = data?.installations[0];
  return inst ? <LarkConversationForm workspaceId="ws" installation={inst} disabled={data?.conversation_supported !== true || isError || isFetching} /> : null;
}

function viewQueryDriven(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return (
    <QueryClientProvider client={qc}>
      <QueryDrivenForm />
    </QueryClientProvider>
  );
}

async function openForm() {
  const user = userEvent.setup();
  await user.click(await screen.findByText("Agent conversations"));
  return user;
}

beforeEach(() => {
  mutation.mutateAsync.mockReset().mockResolvedValue({});
  mutation.isPending = false;
  mutation.isError = false;
  capsMock.mockReset().mockResolvedValue(CAPS);
  chatsMock.mockReset().mockResolvedValue({
    items: [
      { chat_id: "oc_a", name: "Alpha", description: "", avatar: "", external: false, chat_status: "normal" },
    ],
    has_more: false,
    next_cursor: "",
  });
  candidatesMock.mockReset().mockResolvedValue({
    items: [
      {
        id: "cand1",
        chat_id: "oc_dm_alice",
        chat_type: "p2p",
        sender: { type: "user", id: "ou_alice", id_type: "open_id" },
        display_name: "Alice",
        identity_status: "name_available",
        authorization_status: "pending",
        first_seen_at: "2026-09-13T12:00:00Z",
        last_seen_at: "2026-09-13T12:00:00Z",
        expires_at: "2026-09-20T12:00:00Z",
      },
    ],
    max_candidates: 50,
    retention_seconds: 604800,
  });
  confirmMock.mockReset().mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000001",
    authorized_by: "00000000-0000-4000-8000-000000000004",
    scope: "workspace",
    chats: [{ chat_id: "oc_dm_alice", chat_type: "p2p" }],
  });
  installationsMock.mockReset().mockResolvedValue({ installations: [installation], configured: true, conversation_supported: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("authorizes an installation without a grant and authorizes it again after revocation", async () => {
  let current = installation;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    installations: [current], configured: true, conversation_supported: true,
  }))));
  installationsMock.mockImplementation(() => new ApiClient("https://api.example.test").listLarkInstallations("ws"));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(viewQueryDriven(qc));
  const user = await openForm();
  const directs = await screen.findByLabelText(/Direct chat IDs/);
  await user.type(directs, "oc_dm");
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenNthCalledWith(1, [{ chat_id: "oc_dm", chat_type: "p2p" }]);

  current = { ...installation, conversation: {
    id: "00000000-0000-4000-8000-000000000001",
    authorized_by: "00000000-0000-4000-8000-000000000004",
    scope: "workspace", chats: [{ chat_id: "oc_dm", chat_type: "p2p" }],
  } };
  await act(async () => { await qc.refetchQueries({ queryKey: larkKeys.installations("ws") }); });
  await user.click(screen.getByRole("button", { name: "Revoke conversations" }));
  expect(mutation.mutateAsync).toHaveBeenNthCalledWith(2, []);
  // The actual server omits the field after revocation, just as on first install.
  current = installation;
  await act(async () => { await qc.refetchQueries({ queryKey: larkKeys.installations("ws") }); });
  await user.type(directs, "oc_next");
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenNthCalledWith(3, [{ chat_id: "oc_next", chat_type: "p2p" }]);
  qc.clear();
});

it("re-baselines when a refresh omits a revoked grant without resurrecting its chats", async () => {
  let current: LarkInstallation = { ...installation, conversation: {
    id: "00000000-0000-4000-8000-000000000001",
    authorized_by: "00000000-0000-4000-8000-000000000004",
    scope: "workspace", chats: [{ chat_id: "oc_existing", chat_type: "p2p" }],
  } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    installations: [current], configured: true, conversation_supported: true,
  }))));
  installationsMock.mockImplementation(() => new ApiClient("https://api.example.test").listLarkInstallations("ws"));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(viewQueryDriven(qc));
  const user = await openForm();
  const directs = await screen.findByLabelText(/Direct chat IDs/);
  await user.type(directs, "\noc_local");
  current = installation;
  await act(async () => { await qc.refetchQueries({ queryKey: larkKeys.installations("ws") }); });
  await waitFor(() => expect(directs).toHaveValue("oc_local"));
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([{ chat_id: "oc_local", chat_type: "p2p" }]);
  qc.clear();
});

it("keeps other installations visible but blocks replacement of an unreadable grant", async () => {
  const grant = {
    id: "00000000-0000-4000-8000-000000000001",
    authorized_by: "00000000-0000-4000-8000-000000000004",
    scope: "workspace",
    chats: [{ chat_id: "oc_existing", chat_type: "group" }, { chat_id: "oc_future", chat_type: "future" }],
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    installations: [
      { ...installation, conversation: grant },
      { ...installation, id: "other" },
    ], configured: true, conversation_supported: true,
  }))));
  installationsMock.mockImplementation(() => new ApiClient("https://api.example.test").listLarkInstallations("ws"));
  function Installations() {
    const { data } = useQuery(larkInstallationsOptions("ws"));
    return data?.installations.map((inst) => <div key={inst.id}>
      <span>{inst.id}</span>
      {inst.id === "inst" && <LarkConversationForm workspaceId="ws" installation={inst} disabled={false} />}
    </div>);
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(<QueryClientProvider client={qc}><Installations /></QueryClientProvider>);
  await screen.findByText("other");
  const user = await openForm();
  expect(screen.getByRole("status")).toHaveTextContent("Configuration is unavailable");
  const save = screen.getByRole("button", { name: "Authorize conversations" });
  const revoke = screen.getByRole("button", { name: "Revoke conversations" });
  expect(save).toBeDisabled();
  expect(revoke).toBeDisabled();
  await user.click(save);
  await user.click(revoke);
  expect(mutation.mutateAsync).not.toHaveBeenCalled();
  qc.clear();
});

it("retains the last readable grant and local edits through an unreadable refresh", async () => {
  const readable: LarkInstallation = { ...installation, conversation: {
    id: "00000000-0000-4000-8000-000000000001",
    authorized_by: "00000000-0000-4000-8000-000000000004",
    scope: "workspace", chats: [{ chat_id: "oc_existing", chat_type: "p2p" }],
  } };
  const { rerender } = renderWithI18n(view(false, readable));
  const user = await openForm();
  const directs = await screen.findByLabelText(/Direct chat IDs/);
  await user.type(directs, "\noc_local");
  rerender(view(false, { ...readable, conversation: { ...readable.conversation!, scope: "unreadable", chats: [] } }));
  expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled();
  expect(directs).toHaveValue("oc_existing\noc_local");
  rerender(view(false, { ...readable, conversation: { ...readable.conversation! } }));
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([
    { chat_id: "oc_existing", chat_type: "p2p" },
    { chat_id: "oc_local", chat_type: "p2p" },
  ]);
});

it.each([
  { label: /Direct chat IDs/, chatType: "p2p" },
  { label: /Group chat IDs/, chatType: "group" },
])("keeps $chatType drafts editable and focused while unverifiable configuration blocks writes", async ({ label, chatType }) => {
  capsMock.mockRejectedValue(new ApiError("Not Found", 404, "Not Found"));
  const { rerender } = renderWithI18n(view(false));
  const user = await openForm();

  const input = await screen.findByLabelText(label);
  await user.type(input, "oc_manual");

  rerender(view(true));
  expect(input).toHaveValue("oc_manual");
  expect(input).toBeEnabled();
  expect(input).toHaveFocus();
  await user.type(input, "\noc_local");
  expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke conversations" })).toBeDisabled();
  expect(mutation.mutateAsync).not.toHaveBeenCalled();

  rerender(view(false));
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([
    { chat_id: "oc_manual", chat_type: chatType },
    { chat_id: "oc_local", chat_type: chatType },
  ]);
});

it("authorizes picked groups plus direct chats in one save", async () => {
  renderWithI18n(view(false));
  const user = await openForm();

  await user.click(await screen.findByRole("button", { name: /add groups/i }));
  await user.click(await screen.findByRole("checkbox", { name: /Alpha/ }));
  await user.type(screen.getByLabelText(/Direct chat IDs/), "oc_dm");
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));

  expect(mutation.mutateAsync).toHaveBeenCalledWith([
    { chat_id: "oc_a", chat_type: "group" },
    { chat_id: "oc_dm", chat_type: "p2p" },
  ]);
});

it("revokes everything and clears the draft", async () => {
  const granted: LarkInstallation = {
    ...installation,
    conversation: {
      id: "00000000-0000-4000-8000-000000000001", authorized_by: "00000000-0000-4000-8000-000000000004", scope: "workspace",
      chats: [
        { chat_id: "oc_saved", chat_type: "group" },
        { chat_id: "oc_dm", chat_type: "p2p" },
      ],
    },
  };
  renderWithI18n(view(false, granted));
  const user = await openForm();

  // Saved grants render as a removable chip plus the p2p line.
  expect(await screen.findByText("oc_saved")).toBeInTheDocument();
  expect(screen.getByLabelText(/Direct chat IDs/)).toHaveValue("oc_dm");

  await user.click(screen.getByRole("button", { name: "Revoke conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([]);
  await waitFor(() =>
    expect(screen.getByLabelText(/Direct chat IDs/)).toHaveValue(""));
  expect(screen.queryByText("oc_saved")).not.toBeInTheDocument();
});

it("keeps the legacy group ID textarea when discovery is unsupported", async () => {
  capsMock.mockRejectedValue(new ApiError("Not Found", 404, "Not Found"));
  renderWithI18n(view(false));
  const user = await openForm();

  const legacy = await screen.findByLabelText(/Group chat IDs/);
  await user.type(legacy, "oc_manual\noc_manual");
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));

  // Duplicates collapse instead of tripping the server's duplicate check.
  expect(mutation.mutateAsync).toHaveBeenCalledWith([{ chat_id: "oc_manual", chat_type: "group" }]);
});

it("blocks saving past the 50-conversation cap with an inline hint", async () => {
  const granted: LarkInstallation = {
    ...installation,
    conversation: {
      id: "00000000-0000-4000-8000-000000000001", authorized_by: "00000000-0000-4000-8000-000000000004", scope: "workspace",
      chats: Array.from({ length: 50 }, (_, i) => ({ chat_id: `oc_${i}`, chat_type: "group" as const })),
    },
  };
  renderWithI18n(view(false, granted));
  const user = await openForm();

  // 50 saved groups + one direct chat line = 51 → save is blocked.
  await user.type(screen.getByLabelText(/Direct chat IDs/), "oc_extra");
  expect(await screen.findByText(/at most 50 conversations/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled();
  expect(mutation.mutateAsync).not.toHaveBeenCalled();
});

it("confirms a discovered private chat and saves it with the groups in one draft", async () => {
  capsMock.mockResolvedValue(PRIVATE_CAPS);
  renderWithI18n(viewQueryDriven());
  const user = await openForm();

  // The legacy p2p textarea is gone once candidate discovery is supported.
  await waitFor(() =>
    expect(screen.queryByLabelText(/Direct chat IDs/)).not.toBeInTheDocument());

  // Confirm the discovered candidate: the confirm endpoint (not the
  // full-list PUT) records consent; the returned grant re-baselines the
  // draft through the installations cache and the chat appears as a chip.
  await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
  await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));
  await waitFor(() =>
    expect(confirmMock).toHaveBeenCalledWith("ws", "inst", ["cand1"]));
  expect(await screen.findByRole("button", { name: /remove Alice/i })).toBeInTheDocument();

  // Pick a group too, then the full-list save carries both sections.
  await user.click(screen.getByRole("button", { name: /add groups/i }));
  await user.click(await screen.findByRole("checkbox", { name: /Alpha/ }));
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([
    { chat_id: "oc_a", chat_type: "group" },
    { chat_id: "oc_dm_alice", chat_type: "p2p" },
  ]);
});

it("keeps a saved private chat revocable even when it is not a candidate", async () => {
  capsMock.mockResolvedValue(PRIVATE_CAPS);
  const granted: LarkInstallation = {
    ...installation,
    conversation: {
      id: "00000000-0000-4000-8000-000000000001", authorized_by: "00000000-0000-4000-8000-000000000004", scope: "workspace",
      chats: [{ chat_id: "oc_dm_old", chat_type: "p2p" }],
    },
  };
  renderWithI18n(view(false, granted));
  const user = await openForm();

  // oc_dm_old is in the saved grant but not in the candidate list — it still
  // renders as a removable chip.
  expect(await screen.findByText("oc_dm_old")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /remove oc_dm_old/i }));
  await user.click(screen.getByRole("button", { name: /add groups/i }));
  await user.click(await screen.findByRole("checkbox", { name: /Alpha/ }));
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));

  // The revoked p2p chat is gone from the saved list; the group stays.
  expect(mutation.mutateAsync).toHaveBeenCalledWith([
    { chat_id: "oc_a", chat_type: "group" },
  ]);
});
