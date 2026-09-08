// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { dependencyReadiness } from "./dependency-schemas";

const view = {
  blocked_by: [], inherited_blocked_by: [], blocking: [], unsatisfied: [],
  has_restricted_blockers: false, dependency_version: "opaque-version",
};
const prerequisite = {
  issue_id: "a", status: "todo", status_category: "todo", satisfied: false,
  source_edges: ["edge"], inherited_from: [],
};
const issue = {
  id: "b", workspace_id: "ws", number: 1, identifier: "OL-1", title: "B",
  description: null, status: "backlog", priority: "none", assignee_type: null,
  assignee_id: null, creator_type: "member", creator_id: "u", parent_issue_id: null,
  project_id: null, position: 0, stage: null, start_date: null, due_date: null,
  metadata: {}, properties: {}, created_at: "2026-09-08", updated_at: "2026-09-08",
};
function respond(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());

describe("dependency API boundary", () => {
  it("preserves structured partial-batch rejections", async () => {
    respond({ updated: 1, results: [
      { issue_id: "a", updated: true },
      { issue_id: "b", updated: false, reason_code: "dependency_unsatisfied", dependencies: { ...view, has_restricted_blockers: true } },
    ] });
    const result = await new ApiClient("https://api.example.test").batchUpdateIssues(["a", "b"], { status: "todo" });
    expect(result.updated).toBe(1);
    expect(result.results?.[1]?.reasonCode).toBe("dependency_unsatisfied");
    expect(dependencyReadiness(result.results?.[1]?.dependencies)).toBe("blocked");
  });

  it.each([{ updated: 1 }, { updated: 1, results: [{ updated: true }] }])("keeps unavailable batch diagnostics unknown: %j", async (body) => {
    respond(body);
    expect(await new ApiClient("https://api.example.test").batchUpdateIssues(["a"], {}))
      .toEqual({ updated: 1, results: null });
  });

  it("rejects a malformed batch total without claiming success", async () => {
    respond({ updated: "all" });
    await expect(new ApiClient("https://api.example.test").batchUpdateIssues(["a"], {}))
      .rejects.toThrow("Invalid batch update response");
  });

  it.each([{}, null, { ...view, blocked_by: "broken" }, { ...view, dependency_version: "" },
    { ...view, has_restricted_blockers: undefined }, { ...view, blocked_by: [{ issue_id: "a" }] },
    { ...view, blocked_by: [{ ...prerequisite, satisfied: true }] },
    { ...view, blocked_by: [{ ...prerequisite, source_edges: [] }] },
  ])("treats malformed or incomplete decisions as unknown: %j", async (body) => {
    respond(body);
    const result = await new ApiClient("https://api.example.test").getIssueDependencies("b");
    expect(result).toBeNull();
    expect(dependencyReadiness(result)).toBe("unknown");
  });

  it("converts wire fields and preserves restricted blockers", async () => {
    respond({ ...view, has_restricted_blockers: true });
    const result = await new ApiClient("https://api.example.test").getIssueDependencies("b");
    expect(result?.dependencyVersion).toBe("opaque-version");
    expect(dependencyReadiness(result)).toBe("blocked");
  });

  it("does not infer readiness from an inconsistent empty unsatisfied list", async () => {
    respond({ ...view, blocked_by: [prerequisite] });
    const result = await new ApiClient("https://api.example.test").getIssueDependencies("b");
    expect(result?.blockedBy[0]?.sourceEdges).toEqual(["edge"]);
    expect(dependencyReadiness(result)).toBe("blocked");
  });

  it("uses compound writes with explicit empty vs omitted replacement", async () => {
    const client = new ApiClient("https://api.example.test");
    let mock = respond({ ...issue, dependencies: view }, 201);
    await client.createIssueWithDependencies({ title: "B", blockedBy: ["a"] });
    expect(mock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/issues/with-dependencies");
    expect(JSON.parse(mock.mock.calls[0]?.[1].body)).toEqual({ title: "B", blocked_by: ["a"] });
    mock = respond({ ...issue, dependencies: view });
    await client.updateIssueWithDependencies("b", { blockedBy: [], expectedDependencyVersion: "v" });
    expect(mock.mock.calls[0]?.[1].method).toBe("PATCH");
    expect(JSON.parse(mock.mock.calls[0]?.[1].body)).toEqual({ blocked_by: [], expected_dependency_version: "v" });
    mock = respond({ ...issue, dependencies: view });
    await client.updateIssueWithDependencies("b", { title: "updated" });
    expect(JSON.parse(mock.mock.calls[0]?.[1].body)).toEqual({ title: "updated" });
  });

  it.each([404, 405])("never retries against the legacy create path after %i", async (status) => {
    const mock = respond({ error: "not found" }, status);
    await expect(new ApiClient("https://api.example.test").createIssueWithDependencies({ title: "B", blockedBy: ["a"] })).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed issue usable while malformed additive data remains unknown", async () => {
    respond({ ...issue, dependencies: {} }, 201);
    const result = await new ApiClient("https://api.example.test").createIssueWithDependencies({ title: "B" });
    expect(result.id).toBe("b");
    expect(dependencyReadiness(result.dependencies)).toBe("unknown");
  });
});
