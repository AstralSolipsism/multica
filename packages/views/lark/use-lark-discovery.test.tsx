// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LarkChatsPage } from "@multica/core/types";
import { useLarkTargetChats } from "./use-lark-discovery";

const read = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api, listLarkTargetChats: read } };
});
afterEach(() => { cleanup(); read.mockReset(); });

it("pauses empty-page continuation while collapsed and resumes on expansion", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  let finishFirst!: (page: LarkChatsPage) => void;
  read.mockImplementationOnce(() => new Promise<LarkChatsPage>((resolve) => { finishFirst = resolve; }));
  read.mockResolvedValue({ items: [], has_more: false, next_cursor: "" });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(
    ({ enabled }) => useLarkTargetChats("ws", "inst", { enabled }),
    { initialProps: { enabled: true }, wrapper },
  );
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  rerender({ enabled: false });
  await act(async () => { finishFirst({ items: [], has_more: true, next_cursor: "page-2" }); });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(read).toHaveBeenCalledOnce();
  expect(result.current.hasMore).toBe(true);

  rerender({ enabled: true });
  await waitFor(() => expect(result.current.hasMore).toBe(false));
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]![2].cursor).toBe("page-2");
  qc.clear();
});
