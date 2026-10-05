import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { larkKeys } from "@multica/core/lark";
import type { ListLarkInstallationsResponse } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { LarkTab } from "./lark-tab";

const installations = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api,
    listLarkInstallations: installations,
    listMembers: vi.fn(async () => [{ user_id: "owner", role: "owner" }]),
    getLarkTargetCapabilities: vi.fn(async () => ({
      chat_list_supported: false,
      private_chat_candidates_supported: false,
      message_anchor_list_supported: false,
      region: "feishu",
      scope_status: "not_checked",
      max_chat_page_size: 100,
      max_message_page_size: 50,
    })),
  } };
});
vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (select: (state: { user: { id: string } }) => unknown) => select({ user: { id: "owner" } }),
    { getState: () => ({ user: { id: "owner" } }) },
  ),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getAgentName: () => "Connected agent" }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../message-delivery", () => ({ TeamSubscriptionsSection: () => null }));

const connected: ListLarkInstallationsResponse = {
  configured: true,
  install_supported: true,
  conversation_supported: true,
  installations: [{
    id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app",
    bot_open_id: "bot", installer_user_id: "owner", status: "active",
    installed_at: "2026-10-01T00:00:00Z", created_at: "", updated_at: "",
  }],
};

let client: QueryClient;
beforeEach(() => {
  installations.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

it("shows an initial read failure and retries before deciding whether the integration is enabled", async () => {
  let rejectInitial!: (error: Error) => void;
  installations.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectInitial = reject; }));
  renderWithI18n(<QueryClientProvider client={client}><LarkTab /></QueryClientProvider>);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByText("Lark integration not enabled")).not.toBeInTheDocument();
  await act(async () => rejectInitial(new Error("Connection failed")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load connected bots.");
  expect(screen.queryByText("Lark integration not enabled")).not.toBeInTheDocument();
  expect(screen.queryByText("No bots connected yet")).not.toBeInTheDocument();

  let resolveRetry!: (value: ListLarkInstallationsResponse) => void;
  installations.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(installations).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Lark integration not enabled")).not.toBeInTheDocument();
  expect(screen.queryByText("No bots connected yet")).not.toBeInTheDocument();
  await act(async () => resolveRetry({ installations: [], configured: true, install_supported: true }));
  expect(await screen.findByText("No bots connected yet")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows not enabled only after a successful unconfigured response", async () => {
  installations.mockResolvedValue({ installations: [], configured: false });
  renderWithI18n(<QueryClientProvider client={client}><LarkTab /></QueryClientProvider>);
  expect(await screen.findByText("Lark integration not enabled")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps the cached installation and unsaved conversation draft mounted during a background refresh", async () => {
  installations.mockResolvedValueOnce(connected);
  renderWithI18n(<QueryClientProvider client={client}><LarkTab /></QueryClientProvider>);
  expect(await screen.findByText("Connected agent")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Agent conversations"));
  const draft = await screen.findByRole("textbox", { name: /^Group chat IDs/ });
  fireEvent.change(draft, { target: { value: "oc_unsaved" } });
  expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeEnabled();

  let resolveRefresh!: (value: ListLarkInstallationsResponse) => void;
  installations.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  act(() => { void client.invalidateQueries({ queryKey: larkKeys.installations("ws") }); });
  await waitFor(() => expect(installations).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeDisabled());
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  expect(screen.getByText("Connected agent")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: /^Group chat IDs/ })).toBe(draft);
  expect(draft).toHaveValue("oc_unsaved");

  await act(async () => resolveRefresh(connected));
  await waitFor(() => expect(screen.getByRole("button", { name: "Authorize conversations" })).toBeEnabled());
  expect(draft).toHaveValue("oc_unsaved");
});

it("keeps cached installations on refresh failure and disables retry while the retry is pending", async () => {
  installations.mockResolvedValueOnce(connected);
  renderWithI18n(<QueryClientProvider client={client}><LarkTab /></QueryClientProvider>);
  expect(await screen.findByText("Connected agent")).toBeInTheDocument();

  installations.mockRejectedValueOnce(new Error("Refresh failed"));
  await act(async () => { await client.invalidateQueries({ queryKey: larkKeys.installations("ws") }); });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load connected bots.");
  expect(screen.getByText("Connected agent")).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

  let resolveRetry!: (value: ListLarkInstallationsResponse) => void;
  installations.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  await waitFor(() => expect(installations).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(retry).toBeDisabled());
  expect(retry).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Connected agent")).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

  await act(async () => resolveRetry(connected));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByText("Connected agent")).toBeInTheDocument();
});
