// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@multica/core/api";
import { useLarkMessageAnchors, useLarkTargetChats } from "./use-lark-discovery";

const read = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api, listLarkTargetChats: read, listLarkMessageAnchors: read } };
});
afterEach(() => { cleanup(); read.mockReset(); });

it.each(["groups", "anchors"])("review: retry %s must refetch the failed first page even when more pages exist", async (kind) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const initialItem = kind === "groups"
    ? { chat_id: "oc_removed", name: "Removed group", description: "", avatar: "", external: false, chat_status: "normal" }
    : { message_id: "om_recalled", chat_id: "oc_a", summary: "Recalled message", message_type: "text", create_time: "1700000000000", sender: { type: "anonymous" } };
  read.mockResolvedValue({ items: [initialItem], has_more: true, next_cursor: "page-2" });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => kind === "groups"
    ? useLarkTargetChats("ws", "inst")
    : useLarkMessageAnchors("ws", "inst", "oc_a"), { wrapper });
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  expect(result.current.hasMore).toBe(true);
  expect(read).toHaveBeenCalledOnce();

  // Window focus/reconnect invalidation re-reads the first page, not page 2.
  read.mockRejectedValue(new ApiError("read denied", 403, "Forbidden", { code: "lark_discovery_permission_denied" }));
  await act(async () => { await qc.invalidateQueries({ queryKey: ["lark", "ws"] }); });
  await waitFor(() => expect(result.current.errorKey).toBe("permission_denied"));
  const failedOpts = read.mock.calls.at(-1)!.at(-1);
  expect(failedOpts.cursor).toBeUndefined();
  expect(result.current.hasMore).toBe(true);

  read.mockClear().mockResolvedValue({ items: [], has_more: false, next_cursor: "" });
  await act(async () => { result.current.retry(); });
  await waitFor(() => expect(result.current.errorKey).toBeNull());
  expect(read).toHaveBeenCalledOnce();
  const retryOpts = read.mock.calls[0]!.at(-1);
  expect({ cursor: retryOpts.cursor, items: result.current.items }, "Retry must refresh the failed first page and remove stale rows").toEqual({ cursor: undefined, items: [] });
  qc.clear();
});
