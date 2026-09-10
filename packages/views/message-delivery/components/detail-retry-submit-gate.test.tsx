// @vitest-environment jsdom

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

const row = { ...EMPTY_MESSAGE_SOURCE_DELIVERY, id: "d1", route_id: "r1", status: "uncertain" };
const detailBody = (status = "uncertain") => ({
  delivery: { ...row, status }, content_snapshot: null, target_snapshot: null,
  source_ref: null, receipts: [],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

function mount() {
  const client = createQueryClient();
  const tree = (canManage = true) => (
    <QueryClientProvider client={client}>
      <NavigationProvider value={{
        push: () => {}, replace: () => {}, back: () => {},
        pathname: "/ws/settings", searchParams: new URLSearchParams(), hash: "",
        getShareableUrl: (path: string) => path,
      }}>
        <SourceDeliveryDetailDialog open onOpenChange={() => {}} routeId="r1" delivery={row} canManage={canManage} />
      </NavigationProvider>
    </QueryClientProvider>
  );
  const view = renderWithI18n(tree());
  return { client, view, tree, user: userEvent.setup() };
}

async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByRole("button", { name: /^retry$/i })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /^retry$/i }));
  return screen.findByRole("alertdialog");
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["sent", "uncertain"])("keeps an open confirmation blocked during reread and obeys refreshed %s state", async (newStatus) => {
  const nextRead = deferredResponse();
  const pendingRetry = deferredResponse();
  let reads = 0;
  const retryRequest = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) { retryRequest(); return pendingRetry.promise; }
    reads += 1;
    if (reads === 2) return nextRead.promise;
    return json(detailBody(reads === 1 ? "uncertain" : newStatus));
  }));
  setApiInstance(new ApiClient("https://review.example.test"));
  const { client, view, user } = mount();
  let refresh: Promise<void> | undefined;
  try {
    const confirm = await openConfirm(user);
    const action = within(confirm).getByRole("button", { name: /checked.*retry/i });
    refresh = client.refetchQueries({ queryKey: messageSourceKeys.delivery("ws1", "r1", "d1"), exact: true });
    await waitFor(() => expect(action).toBeDisabled());
    await user.click(action);
    expect(retryRequest).toHaveBeenCalledTimes(0);
    nextRead.resolve(json(detailBody(newStatus)));
    await refresh;
    if (newStatus === "sent") {
      await waitFor(() => expect(action).toBeDisabled());
      await user.click(action);
      expect(retryRequest).toHaveBeenCalledTimes(0);
    } else {
      await waitFor(() => expect(action).toBeEnabled());
      await user.dblClick(action);
      await waitFor(() => expect(retryRequest).toHaveBeenCalledTimes(1));
      expect(action).toBeDisabled();
    }
  } finally {
    view.unmount();
    nextRead.resolve(json(detailBody(newStatus)));
    pendingRetry.resolve(json({ delivery: { ...row, status: "queued" } }));
    await refresh;
    client.clear();
  }
});

it("blocks confirmation after losing permission and permits one submission after permission returns", async () => {
  const pendingRetry = deferredResponse();
  const retryRequest = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) { retryRequest(); return pendingRetry.promise; }
    return json(detailBody());
  }));
  setApiInstance(new ApiClient("https://review.example.test"));
  const { client, view, user, tree } = mount();
  try {
    const confirm = await openConfirm(user);
    const action = within(confirm).getByRole("button", { name: /checked.*retry/i });
    view.rerender(tree(false));
    await waitFor(() => expect(action).toBeDisabled());
    await user.click(action);
    expect(retryRequest).toHaveBeenCalledTimes(0);
    view.rerender(tree(true));
    await waitFor(() => expect(action).toBeEnabled());
    await user.dblClick(action);
    await waitFor(() => expect(retryRequest).toHaveBeenCalledTimes(1));
    expect(action).toBeDisabled();
  } finally {
    view.unmount();
    pendingRetry.resolve(json({ delivery: { ...row, status: "queued" } }));
    client.clear();
  }
});

it.each([403, 500])("keeps confirmation blocked after a failed %i detail refresh until a successful reread", async (status) => {
  let reads = 0;
  const pendingRetry = deferredResponse();
  const retryRequest = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) { retryRequest(); return pendingRetry.promise; }
    reads += 1;
    return reads === 2 ? json({ error: "detail_read_failed" }, status) : json(detailBody());
  }));
  setApiInstance(new ApiClient("https://review.example.test"));
  const { client, view, user } = mount();
  try {
    const confirm = await openConfirm(user);
    const action = within(confirm).getByRole("button", { name: /checked.*retry/i });
    const query = { queryKey: messageSourceKeys.delivery("ws1", "r1", "d1"), exact: true };
    await client.refetchQueries(query);
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(action).toBeDisabled());
    await user.click(action);
    expect(retryRequest).toHaveBeenCalledTimes(0);
    await client.refetchQueries(query);
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(action).toBeEnabled());
    await user.dblClick(action);
    await waitFor(() => expect(retryRequest).toHaveBeenCalledTimes(1));
    expect(action).toBeDisabled();
  } finally {
    view.unmount();
    pendingRetry.resolve(json({ delivery: { ...row, status: "queued" } }));
    client.clear();
  }
});

it("unblocks a legitimate next retry after the first retry fails and guards pending double clicks", async () => {
  const firstRetry = deferredResponse();
  const secondRetry = deferredResponse();
  const retryRequest = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/retry")) {
      retryRequest();
      return retryRequest.mock.calls.length === 1 ? firstRetry.promise : secondRetry.promise;
    }
    return json(detailBody());
  }));
  setApiInstance(new ApiClient("https://review.example.test"));
  const { client, view, user } = mount();
  try {
    const confirm = await openConfirm(user);
    const action = within(confirm).getByRole("button", { name: /checked.*retry/i });
    await user.dblClick(action);
    await waitFor(() => expect(retryRequest).toHaveBeenCalledTimes(1));
    expect(action).toBeDisabled();
    firstRetry.resolve(json({ error: "temporary_failure" }, 500));
    await waitFor(() => expect(action).toBeEnabled());
    await user.dblClick(action);
    await waitFor(() => expect(retryRequest).toHaveBeenCalledTimes(2));
    expect(action).toBeDisabled();
    secondRetry.resolve(json({ delivery: { ...row, status: "queued" } }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(retryRequest).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    firstRetry.resolve(json({ error: "temporary_failure" }, 500));
    secondRetry.resolve(json({ delivery: { ...row, status: "queued" } }));
    client.clear();
  }
});
