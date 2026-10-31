// @vitest-environment node
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  projectBaselineDiffOptions,
  projectBaselineHistoryOptions,
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
      "projects", "ws-1", "detail", "project-1", "engineering", "overview",
    ]);
  });

  it("scopes baseline history and historical diffs by workspace, project, and chapter", async () => {
    const history = { revisions: [], hasMore: false, nextBefore: null };
    const diff = { chapter: "architecture", added: [], modified: [], removed: [] };
    const getProjectBaselineHistory = vi.fn().mockResolvedValue(history);
    const diffProjectBaselineHistory = vi.fn().mockResolvedValue(diff);
    setApiInstance({ getProjectBaselineHistory, diffProjectBaselineHistory } as unknown as ApiClient);
    const historyOptions = projectBaselineHistoryOptions("ws-1", "project-1", "architecture", { limit: 25, before: 7 });
    const diffOptions = projectBaselineDiffOptions("ws-1", "project-1", "architecture", 2, 5);

    await expect(qc.fetchQuery(historyOptions)).resolves.toBe(history);
    await expect(qc.fetchQuery(diffOptions)).resolves.toBe(diff);
    expect(getProjectBaselineHistory).toHaveBeenCalledWith(
      "ws-1", "project-1", "architecture", { limit: 25, before: 7 },
    );
    expect(diffProjectBaselineHistory).toHaveBeenCalledWith("ws-1", "project-1", "architecture", 2, 5);
    expect(historyOptions.queryKey).toEqual([
      ...projectKeys.engineeringHistoryAll("ws-1", "project-1"),
      "architecture",
      { limit: 25, before: 7 },
    ]);
    expect(diffOptions.queryKey).toEqual([
      ...projectKeys.engineeringHistoryAll("ws-1", "project-1"),
      "architecture", "diff", 2, 5,
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
