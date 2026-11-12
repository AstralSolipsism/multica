// @vitest-environment node
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  projectEngineeringConfigOptions,
  projectEngineeringDecisionIssuesOptions,
  projectEngineeringOptions,
  projectKeys,
  projectWikiHistoryOptions,
  projectWikiPageOptions,
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
      projectKeys.wikiTree("ws-1", "project-1", false),
      projectKeys.wikiPage("ws-1", "project-1", "overview", {}),
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

  it("roots wiki page keys under the per-project wiki prefix", () => {
    expect(projectKeys.wikiRoot("ws-1", "project-1")).toEqual([
      "project-engineering", "ws-1", "project-1", "wiki",
    ]);
    expect(projectKeys.wikiPageAll("ws-1", "project-1", "overview")).toEqual([
      ...projectKeys.wikiRoot("ws-1", "project-1"), "page", "overview",
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

  it("scopes wiki page history by workspace, project, page and page shape", async () => {
    const history = { revisions: [], hasMore: false, nextBefore: null };
    const getProjectWikiPageHistory = vi.fn().mockResolvedValue(history);
    setApiInstance({ getProjectWikiPageHistory } as unknown as ApiClient);
    const historyOptions = projectWikiHistoryOptions("ws-1", "project-1", "architecture", { limit: 25, before: 7 });

    await expect(qc.fetchQuery(historyOptions)).resolves.toBe(history);
    expect(getProjectWikiPageHistory).toHaveBeenCalledWith(
      "ws-1", "project-1", "architecture", { limit: 25, before: 7 },
    );
    expect(historyOptions.queryKey).toEqual([
      ...projectKeys.wikiHistoryAll("ws-1", "project-1", "architecture"),
      { limit: 25, before: 7 },
    ]);
  });

  it("keys wiki page reads by page and read options", async () => {
    const page = { page: null };
    const getProjectWikiPage = vi.fn().mockResolvedValue(page);
    setApiInstance({ getProjectWikiPage } as unknown as ApiClient);
    const options = projectWikiPageOptions("ws-1", "project-1", "overview", { with: ["links", "backlinks"] });

    await expect(qc.fetchQuery(options)).resolves.toBe(page);
    expect(getProjectWikiPage).toHaveBeenCalledWith(
      "ws-1", "project-1", "overview", { with: ["links", "backlinks"] },
    );
    expect(options.queryKey).toEqual([
      ...projectKeys.wikiPageAll("ws-1", "project-1", "overview"),
      { with: ["links", "backlinks"] },
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
