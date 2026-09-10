// @vitest-environment jsdom

// OL-28 review regression (reviewer repro, adopted): the delivery detail's
// retry must be decided by a COMPLETED current detail read, never by a stale
// list row — while the read is pending, retry stays blocked.

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiClient } from "@multica/core/api/client";
import { setApiInstance } from "@multica/core/api";
import { createQueryClient } from "@multica/core/query-client";
import { messageSourceKeys } from "@multica/core/message-delivery";
import { EMPTY_MESSAGE_SOURCE_DELIVERY } from "@multica/core/api/schemas";
import { SourceDeliveryDetailDialog } from "./route-deliveries-dialog";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: async () => [] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps retry blocked while refreshing a stale failed row whose actual detail is uncertain", async () => {
  const client = createQueryClient();
  const stale = { ...EMPTY_MESSAGE_SOURCE_DELIVERY, id: "d1", route_id: "r1", status: "failed" };
  let finishRead!: (response: Response) => void;
  const pendingRead = new Promise<Response>((resolve) => { finishRead = resolve; });
  const retryRequest = vi.fn();
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) {
      retryRequest();
      return new Response(JSON.stringify({ delivery: { ...stale, status: "queued" } }));
    }
    return pendingRead;
  });
  vi.stubGlobal("fetch", fetch);
  setApiInstance(new ApiClient("https://review.example.test"));
  const view = renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={{
        push: () => {}, replace: () => {}, back: () => {},
        pathname: "/ws/settings", searchParams: new URLSearchParams(), hash: "",
        getShareableUrl: (path: string) => path,
      }}>
        <SourceDeliveryDetailDialog open onOpenChange={() => {}} routeId="r1" delivery={stale} canManage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  try {
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await userEvent.setup().click(screen.getByRole("button", { name: /^retry$/i }));
    expect(retryRequest).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    finishRead(new Response(JSON.stringify({
      delivery: { ...stale, status: "uncertain" }, content_snapshot: null,
      target_snapshot: null, source_ref: null, receipts: [],
    })));
    client.clear();
  }
});

it("blocks the already-open uncertain confirmation while a newer detail read is pending", async () => {
  const client = createQueryClient();
  const row = { ...EMPTY_MESSAGE_SOURCE_DELIVERY, id: "d1", route_id: "r1", status: "uncertain" };
  const detail = { delivery: row, content_snapshot: null, target_snapshot: null, source_ref: null, receipts: [] };
  let finishRead!: (body: string) => void;
  const pendingBody = new Promise<string>((resolve) => { finishRead = resolve; });
  let reads = 0;
  const retryRequest = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) {
      retryRequest();
      return new Response(JSON.stringify({ delivery: { ...row, status: "queued" } }));
    }
    reads += 1;
    return new Response(reads === 1 ? JSON.stringify(detail) : await pendingBody);
  }));
  setApiInstance(new ApiClient("https://review.example.test"));
  const view = renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={{
        push: () => {}, replace: () => {}, back: () => {},
        pathname: "/ws/settings", searchParams: new URLSearchParams(), hash: "",
        getShareableUrl: (path: string) => path,
      }}>
        <SourceDeliveryDetailDialog open onOpenChange={() => {}} routeId="r1" delivery={row} canManage />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  let refresh: Promise<void> | undefined;
  try {
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole("button", { name: /^retry$/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    const confirm = await screen.findByRole("alertdialog");
    refresh = client.refetchQueries({ queryKey: messageSourceKeys.delivery("ws1", "r1", "d1"), exact: true });
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByText(/Reading the current state/)).toBeInTheDocument());
    await user.click(within(confirm).getByRole("button", { name: /checked.*retry/i }));
    expect(retryRequest).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    finishRead(JSON.stringify(detail));
    await refresh;
    client.clear();
  }
});
