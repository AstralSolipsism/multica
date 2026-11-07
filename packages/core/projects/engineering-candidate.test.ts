// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { BaselineChapter, BaselineRevision, EngineeringOverview } from "../api";
import { engineeringCandidateOptions } from "./engineering-candidate";
import { projectKeys } from "./queries";

const revision = (id: string, status = "candidate", revisionNumber = 1) => ({ id, status, revisionNumber }) as BaselineRevision;
const chapterState = (chapter: BaselineChapter, candidate: BaselineRevision | null = null) => ({ chapter, title: "", position: 0, adopted: null, candidate });
const overview = (candidate: BaselineRevision | null): EngineeringOverview => ({
  engineering: {} as EngineeringOverview["engineering"],
  chapters: [
    chapterState("overview", candidate), chapterState("domain_rules"), chapterState("architecture"),
    chapterState("exclusions_and_risks"), chapterState("module:billing"),
  ],
});
const page = (revisions: BaselineRevision[], nextBefore: number | null = null) => ({ revisions, hasMore: nextBefore !== null, nextBefore });

describe("engineeringCandidateOptions", () => {
  let qc: QueryClient;
  beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
  afterEach(() => { qc.clear(); vi.restoreAllMocks(); });

  it("nests candidate lookups under the engineering invalidation scope", () => {
    expect(engineeringCandidateOptions("ws-1", "project-1", "rev-1").queryKey).toEqual([
      ...projectKeys.engineeringAll("ws-1", "project-1"),
      "candidate",
      "rev-1",
    ]);
  });

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

  it("finds a closed revision through metadata-only history pagination, then reads its body", async () => {
    const summary = revision("rev-old", "withdrawn", 3);
    const historical = { ...summary, contentMarkdown: "## Body" };
    const getProjectEngineering = vi.fn().mockResolvedValue(overview(null));
    const getProjectBaselineHistory = vi.fn()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([revision("rev-other", "superseded", 5)], 4))
      .mockResolvedValueOnce(page([summary]))
      .mockResolvedValueOnce(page([historical]));
    setApiInstance({ getProjectEngineering, getProjectBaselineHistory } as unknown as ApiClient);

    await expect(qc.fetchQuery(engineeringCandidateOptions("ws-1", "project-1", "rev-old"))).resolves.toEqual({
      chapter: "domain_rules", revision: historical, current: false,
    });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(1, "ws-1", "project-1", "overview", { limit: 200, before: undefined, withContent: false });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(2, "ws-1", "project-1", "domain_rules", { limit: 200, before: undefined, withContent: false });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(3, "ws-1", "project-1", "domain_rules", { limit: 200, before: 4, withContent: false });
    expect(getProjectBaselineHistory).toHaveBeenNthCalledWith(4, "ws-1", "project-1", "domain_rules", { limit: 1, before: 4 });
  });

  it("finds a closed revision in a module chapter", async () => {
    const historical = revision("rev-module", "rejected", 2);
    const getProjectEngineering = vi.fn().mockResolvedValue(overview(null));
    const getProjectBaselineHistory = vi.fn((_ws: string, _project: string, chapter: BaselineChapter) =>
      Promise.resolve(page(chapter === "module:billing" ? [historical] : [])));
    setApiInstance({ getProjectEngineering, getProjectBaselineHistory } as unknown as ApiClient);

    await expect(qc.fetchQuery(engineeringCandidateOptions("ws-1", "project-1", "rev-module"))).resolves.toEqual({
      chapter: "module:billing", revision: historical, current: false,
    });
  });

  it("returns null instead of substituting a different candidate", async () => {
    const getProjectEngineering = vi.fn().mockResolvedValue(overview(revision("rev-current")));
    const getProjectBaselineHistory = vi.fn().mockResolvedValue(page([]));
    setApiInstance({ getProjectEngineering, getProjectBaselineHistory } as unknown as ApiClient);

    await expect(qc.fetchQuery(engineeringCandidateOptions("ws-1", "project-1", "rev-missing"))).resolves.toBeNull();
    expect(getProjectBaselineHistory).toHaveBeenCalledTimes(5);
  });
});
