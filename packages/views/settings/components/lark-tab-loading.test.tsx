import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ListLarkInstallationsResponse } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { LarkTab } from "./lark-tab";

const installations = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api,
    listLarkInstallations: installations,
    listMembers: vi.fn(async () => []),
  } };
});
vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (select: (state: { user: null }) => unknown) => select({ user: null }),
    { getState: () => ({ user: null }) },
  ),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("../../message-delivery", () => ({ TeamSubscriptionsSection: () => null }));

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
