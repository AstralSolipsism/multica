import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { larkKeys } from "@multica/core/lark";
import type { ListLarkInstallationsResponse } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { LarkTab } from "./lark-tab";

const installations = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api,
    listLarkInstallations: installations,
    deleteLarkInstallation: disconnect,
    listMembers: vi.fn(async () => [{ user_id: "owner", role: "owner" }]),
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
  installations: [{
    id: "inst", workspace_id: "ws", agent_id: "agent", app_id: "app",
    bot_open_id: "bot", installer_user_id: "owner", status: "active",
    installed_at: "2026-10-01T00:00:00Z", created_at: "", updated_at: "",
  }],
};

let client: QueryClient;
beforeEach(() => {
  installations.mockReset();
  disconnect.mockReset().mockResolvedValue(undefined);
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

it("keeps the cached installation mounted during a background refresh", async () => {
  installations.mockResolvedValueOnce(connected);
  renderWithI18n(<QueryClientProvider client={client}><LarkTab /></QueryClientProvider>);
  const row = await screen.findByText("Connected agent");

  let resolveRefresh!: (value: ListLarkInstallationsResponse) => void;
  installations.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  act(() => { void client.invalidateQueries({ queryKey: larkKeys.installations("ws") }); });
  await waitFor(() => expect(installations).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  expect(screen.getByText("Connected agent")).toBe(row);

  await act(async () => resolveRefresh(connected));
  expect(screen.getByText("Connected agent")).toBe(row);
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
  expect(client.isFetching({ queryKey: larkKeys.installations("ws") })).toBe(0);

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

it("disconnects the selected installation when several bots are listed", async () => {
  installations.mockResolvedValue({ ...connected, installations: [
    connected.installations[0]!,
    { ...connected.installations[0]!, id: "inst-2", agent_id: "agent-2" },
  ] });
  renderWithI18n(<QueryClientProvider client={client}><LarkTab /></QueryClientProvider>);
  const buttons = await screen.findAllByRole("button", { name: "Disconnect" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]!);
  const confirmation = await screen.findByRole("alertdialog", { name: "Disconnect this Lark bot?" });
  expect(disconnect).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledExactlyOnceWith("ws", "inst-2"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
});
