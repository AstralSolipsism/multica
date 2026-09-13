// @vitest-environment jsdom

import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
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
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getLarkTargetCapabilities: (...args: unknown[]) => capsMock(...args),
      listLarkTargetChats: (...args: unknown[]) => chatsMock(...args),
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

async function openForm() {
  const user = userEvent.setup();
  await user.click(screen.getByText("Agent conversations"));
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
});

afterEach(() => cleanup());

it("preserves the edited conversations and blocks save/revoke while configuration cannot be verified", async () => {
  const { rerender } = renderWithI18n(view(false));
  const user = await openForm();

  // Direct chats keep the manual entry (p2p candidate picking is OL-76).
  const directs = screen.getByLabelText(/Direct chat IDs/);
  await user.type(directs, "oc_dm");

  rerender(view(true));
  expect(directs).toHaveValue("oc_dm");
  expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Revoke conversations" })).toBeDisabled();
  expect(mutation.mutateAsync).not.toHaveBeenCalled();

  rerender(view(false));
  await user.click(screen.getByRole("button", { name: "Authorize conversations" }));
  expect(mutation.mutateAsync).toHaveBeenCalledWith([{ chat_id: "oc_dm", chat_type: "p2p" }]);
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
      id: "grant", authorized_by: "owner", scope: "workspace",
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
      id: "grant", authorized_by: "owner", scope: "workspace",
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
