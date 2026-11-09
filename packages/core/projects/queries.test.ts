// @vitest-environment node
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  projectBaselineAnnotationBatchOptions,
  projectBaselineAnnotationBatchesOptions,
  projectBaselineHistoryOptions,
  projectEngineeringConfigOptions,
  projectEngineeringDecisionIssuesOptions,
  projectEngineeringOptions,
  projectKeys,
} from "./queries";

describe("project engineering queries", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
  });

  it("keeps a malformed overview response as null data for the view to handle", async () => {
    const getProjectEngineering = vi.fn().mockResolvedValue(null);
    setApiInstance({ getProjectEngineering } as unknown as ApiClient);
    const options = projectEngineeringOptions("ws-1", "project-1");

    expect(options.enabled).toBeUndefined();
    await expect(qc.fetchQuery(options)).resolves.toBeNull();
    expect(getProjectEngineering).toHaveBeenCalledWith("ws-1", "project-1");
    expect(options.queryKey).toEqual([
      "project-engineering", "ws-1", "project-1", "overview",
    ]);
  });

  it("keeps engineering reads out of the project prefix that issue events invalidate", () => {
    const keys = [
      projectKeys.engineering("ws-1", "project-1"),
      projectKeys.engineeringConfig("ws-1", "project-1"),
      projectKeys.engineeringHistory("ws-1", "project-1", "overview", { limit: 10, withContent: false }),
    ];
    for (const key of keys) qc.setQueryData(key, null);
    qc.setQueryData(projectKeys.detail("ws-1", "project-1"), null);

    // Issue status/project changes and project events invalidate projects/{wsId}.
    void qc.invalidateQueries({ queryKey: projectKeys.all("ws-1") });

    expect(qc.getQueryState(projectKeys.detail("ws-1", "project-1"))?.isInvalidated).toBe(true);
    for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    void qc.invalidateQueries({ queryKey: projectKeys.engineeringRoot("ws-1") });
    for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("roots baseline annotation keys under the project detail key", () => {
    // engineering-queries.ts re-creates the projects/{wsId}/detail/{id}
    // prefix by value; pin it so an upstream detail-key reshape cannot
    // silently break annotation invalidation.
    expect(projectKeys.baselineAnnotationsAll("ws-1", "project-1")).toEqual([
      ...projectKeys.detail("ws-1", "project-1"),
      "baseline-annotations",
    ]);
  });

  it("requests the configuration without chapter bodies", async () => {
    const config = { engineering: { enabled: true } };
    const getProjectEngineeringConfig = vi.fn().mockResolvedValue(config);
    setApiInstance({ getProjectEngineeringConfig } as unknown as ApiClient);
    const options = projectEngineeringConfigOptions("ws-1", "project-1");

    await expect(qc.fetchQuery(options)).resolves.toBe(config);
    expect(getProjectEngineeringConfig).toHaveBeenCalledWith("ws-1", "project-1");
    expect(options.queryKey).toEqual(projectKeys.engineeringConfig("ws-1", "project-1"));
  });

  it("scopes baseline history by workspace, project, chapter and page shape", async () => {
    const history = { revisions: [], hasMore: false, nextBefore: null };
    const getProjectBaselineHistory = vi.fn().mockResolvedValue(history);
    setApiInstance({ getProjectBaselineHistory } as unknown as ApiClient);
    const historyOptions = projectBaselineHistoryOptions("ws-1", "project-1", "architecture", { limit: 25, before: 7, withContent: false });

    await expect(qc.fetchQuery(historyOptions)).resolves.toBe(history);
    expect(getProjectBaselineHistory).toHaveBeenCalledWith(
      "ws-1", "project-1", "architecture", { limit: 25, before: 7, withContent: false },
    );
    expect(historyOptions.queryKey).toEqual([
      ...projectKeys.engineeringHistoryAll("ws-1", "project-1"),
      "architecture",
      { limit: 25, before: 7, withContent: false },
    ]);
  });

  it("keys annotation lists by filters and applies complete detail defaults", async () => {
    const batches = { batches: [] };
    const detail = { batch: null, reviews: [], annotations: [], sections: [] };
    const getProjectBaselineAnnotationBatches = vi.fn().mockResolvedValue(batches);
    const getProjectBaselineAnnotationBatch = vi.fn().mockResolvedValue(detail);
    setApiInstance({
      getProjectBaselineAnnotationBatches,
      getProjectBaselineAnnotationBatch,
    } as unknown as ApiClient);
    const listInput = { chapter: "domain_rules", state: "all" } as const;
    const listOptions = projectBaselineAnnotationBatchesOptions("ws-1", "project-1", listInput);
    const detailOptions = projectBaselineAnnotationBatchOptions("ws-1", "project-1", "batch-1");

    await expect(qc.fetchQuery(listOptions)).resolves.toBe(batches);
    await expect(qc.fetchQuery(detailOptions)).resolves.toBe(detail);

    expect(getProjectBaselineAnnotationBatches).toHaveBeenCalledWith("ws-1", "project-1", listInput);
    expect(getProjectBaselineAnnotationBatch).toHaveBeenCalledWith(
      "ws-1", "project-1", "batch-1", { state: "all", withSections: false },
    );
    expect(listOptions.queryKey).toEqual([
      ...projectKeys.baselineAnnotationsAll("ws-1", "project-1"), "batches", listInput,
    ]);
    expect(detailOptions.queryKey).toEqual([
      ...projectKeys.baselineAnnotationsAll("ws-1", "project-1"),
      "batch", "batch-1", { state: "all", withSections: false },
    ]);
  });

  it("lists only blocked member-assigned issues for the selected project decider", async () => {
    const issues = [{ id: "issue-1" }];
    const listIssues = vi.fn().mockResolvedValue({ issues, total: 1 });
    setApiInstance({ listIssues } as unknown as ApiClient);
    const options = projectEngineeringDecisionIssuesOptions("ws-1", "project-1", "member-1");

    const observer = new QueryObserver(qc, options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(issues));
    } finally {
      unsubscribe();
    }
    expect(listIssues).toHaveBeenCalledWith({
      workspace_id: "ws-1",
      project_id: "project-1",
      statuses: ["blocked"],
      assignee_types: ["member"],
      assignee_ids: ["member-1"],
    });
    expect(options.queryKey).toEqual([
      "issues", "ws-1", "engineering-decisions", "project-1", "member-1",
    ]);
  });
});
