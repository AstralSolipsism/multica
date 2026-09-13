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

it.each(["groups", "anchors"])("review: retry %s after a failed background refetch must read the API", async (kind) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  read.mockResolvedValue({ items: [], has_more: false, next_cursor: "" });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => kind === "groups"
    ? useLarkTargetChats("ws", "inst")
    : useLarkMessageAnchors("ws", "inst", "oc_a"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  read.mockRejectedValue(new ApiError("read denied", 403, "Forbidden", { code: "lark_discovery_permission_denied" }));
  await act(async () => { await qc.invalidateQueries({ queryKey: ["lark", "ws"] }); });
  await waitFor(() => expect(result.current.errorKey).toBe("permission_denied"));
  const beforeRetry = read.mock.calls.length;
  read.mockResolvedValue({ items: [], has_more: false, next_cursor: "" });
  await act(async () => { result.current.retry(); });
  await waitFor(() => expect(result.current.errorKey).toBeNull());
  expect(read.mock.calls.length, "Retry must perform an API request rather than mark stale cached data successful").toBeGreaterThan(beforeRetry);
  qc.clear();
});
