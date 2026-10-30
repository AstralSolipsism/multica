import { renderHook } from "@testing-library/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatContextItems } from "./use-chat-context-items";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined })),
  useQueries: vi.fn(() => []),
}));

vi.mock("@multica/core/chat", () => {
  const entries = [
    { id: "issue-2", type: "issue", label: "MUL-2" },
    { id: "project-1", type: "project", label: "Project" },
  ];
  return {
    selectRecentContexts: () => () => entries,
    useRecentContextStore: Object.assign(() => entries, { getState: () => ({}) }),
  };
});

vi.mock("@multica/core/issues/queries", () => ({
  issueDetailOptions: (_wsId: string, id: string) => ({ queryKey: ["issue", id] }),
}));

vi.mock("@multica/core/projects/queries", () => ({
  projectDetailOptions: (_wsId: string, id: string) => ({ queryKey: ["project", id] }),
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    pathname: "/workspace/issues/issue-1",
    searchParams: new URLSearchParams(),
  }),
}));

const mockUseQuery = vi.mocked(useQuery);
const mockUseQueries = vi.mocked(useQueries);
const recentQueryCalls = () => mockUseQueries.mock.calls as unknown as Array<[
  { queries: Array<{ enabled?: boolean }> },
]>;

describe("useChatContextItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables current and recent detail queries while the floating window is closed", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useChatContextItems("ws-1", enabled),
      { initialProps: { enabled: false } },
    );

    expect(mockUseQuery).toHaveBeenCalledTimes(2);
    for (const [options] of mockUseQuery.mock.calls) {
      expect(options.enabled).toBe(false);
    }
    const closedQueries = recentQueryCalls()[0]?.[0].queries ?? [];
    expect(closedQueries).toHaveLength(2);
    expect(closedQueries.every((options) => options.enabled === false)).toBe(true);

    rerender({ enabled: true });

    expect(
      mockUseQuery.mock.calls.slice(2).map(([options]) => options.enabled),
    ).toEqual([true, false]);
    const openQueries = recentQueryCalls().at(-1)?.[0].queries ?? [];
    expect(openQueries.every((options) => options.enabled === true)).toBe(true);
  });
});
