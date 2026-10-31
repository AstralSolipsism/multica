// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { BaselineRevision, EngineeringOverview } from "../api";
import { engineeringCandidateOptions } from "./engineering-candidate";

const revision = (id: string, status = "candidate") => ({ id, status }) as BaselineRevision;
const overview = (candidate: BaselineRevision | null): EngineeringOverview => ({
  engineering: {} as EngineeringOverview["engineering"],
  chapters: [{ chapter: "overview", adopted: null, candidate }],
});

describe("engineeringCandidateOptions", () => {
  let qc: QueryClient;
  beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
  afterEach(() => { qc.clear(); vi.restoreAllMocks(); });

  it("returns the exact current candidate without reading history", async () => {
    const current = revision("rev-current");
    const getProjectEngineering = vi.fn().mockResolvedValue(overview(current));
    const getProjectBaselineHistory = vi.fn();
    setApiInstance({ getProjectEngineering, getProjectBaselineHistory } as unknown as ApiClient);

    await expect(qc.fetchQuery(engineeringCandidateOptions("ws-1", "project-1", "rev-current"))).resolves.toEqual({
      chapter: "overview", revision: current, current: true,
    });
    expect(getProjectBaselineHistory).not.toHaveBeenCalled();
  });

  it("finds a closed revision through chapter history pagination", async () => {
    const historical = revision("rev-old", "withdrawn");
    const getProjectEngineering = vi.fn().mockResolvedValue(overview(null));
    const getProjectBaselineHistory = vi.fn()
      .mockResolvedValueOnce({ revisions: [], hasMore: false, nextBefore: null })
      .mockResolvedValueOnce({ revisions: [revision("rev-other")], hasMore: true, nextBefore: 4 })
      .mockResolvedValueOnce({ revisions: [historical], hasMore: false, nextBefore: null });
    setApiInstance({ getProjectEngineering, getProjectBaselineHistory } as unknown as ApiClient);

    await expect(qc.fetchQuery(engineeringCandidateOptions("ws-1", "project-1", "rev-old"))).resolves.toEqual({
      chapter: "domain_rules", revision: historical, current: false,
    });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(1, "ws-1", "project-1", "overview", { limit: 200, before: undefined });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(2, "ws-1", "project-1", "domain_rules", { limit: 200, before: undefined });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(3, "ws-1", "project-1", "domain_rules", { limit: 200, before: 4 });
  });

  it("returns null instead of substituting a different candidate", async () => {
    const getProjectEngineering = vi.fn().mockResolvedValue(overview(revision("rev-current")));
    const getProjectBaselineHistory = vi.fn().mockResolvedValue({ revisions: [], hasMore: false, nextBefore: null });
    setApiInstance({ getProjectEngineering, getProjectBaselineHistory } as unknown as ApiClient);

    await expect(qc.fetchQuery(engineeringCandidateOptions("ws-1", "project-1", "rev-missing"))).resolves.toBeNull();
    expect(getProjectBaselineHistory).toHaveBeenCalledTimes(4);
  });
});
