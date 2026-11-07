// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { api } from "../api";
import { issueKeys, issueSearchOptions } from "./queries";

vi.mock("../api", () => ({ api: { searchIssues: vi.fn() } }));

it("fetches each page size independently and invalidates both through the workspace prefix", async () => {
  const search = vi.mocked(api.searchIssues).mockImplementation(async ({ limit }) => ({
    issues: [],
    has_more: limit === 1,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const small = issueSearchOptions("workspace", "needle", 1);
    const large = issueSearchOptions("workspace", "needle", 20);
    expect((await client.fetchQuery(small)).has_more).toBe(true);
    expect((await client.fetchQuery(large)).has_more).toBe(false);
    await client.fetchQuery(small);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      q: "needle", limit: 20, include_closed: true, signal: expect.any(AbortSignal),
    }));
    await client.invalidateQueries({ queryKey: issueKeys.all("workspace"), refetchType: "none" });
    expect(client.getQueryState(small.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(large.queryKey)?.isInvalidated).toBe(true);
  } finally {
    client.clear();
  }
});
