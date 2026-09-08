// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { issueGraphReadiness } from "./issue-graph-schemas";
import reference from "./testdata/issue-graph.json";

const request = { query: { scope: { kind: "workspace" as const }, filters: {}, sort: { field: "position" as const, direction: "asc" as const } } };
function respond(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());

describe("issue graph API boundary", () => {
  it("parses the Go reference response, pins the workspace and passes cancellation", async () => {
    const fetch = respond({ ...reference, future_field: true });
    const signal = new AbortController().signal;
    const graph = await new ApiClient("https://api.test").getIssueGraph("ws-1", request, { signal });
    expect(graph?.complete).toBe(true);
    expect(graph?.matchedCount).toBe(14);
    expect(graph?.nodes.find((n) => n.title === "Checkout API")?.dependencySummary?.visibleUnsatisfiedCount).toBe(2);
    expect(graph?.edges).toHaveLength(7);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal, headers: { "X-Workspace-ID": "ws-1", "X-Workspace-Slug": "" } });
  });

  it.each([
    null, {}, { ...reference, complete: false }, { ...reference, schema_version: 2 },
    { ...reference, nodes: reference.nodes.slice(1) },
    { ...reference, nodes: [...reference.nodes, reference.nodes[0]] },
    { ...reference, matched_count: 13 },
    { ...reference, projects: [] },
    { ...reference, edges: [...reference.edges, reference.edges[0]] },
    { ...reference, edges: [{ ...reference.edges[0], source: "missing" }] },
    { ...reference, nodes: reference.nodes.map((n, i) => i === 0 ? { ...n, parent_issue_id: n.id } : n) },
  ])("does not turn incomplete/malformed topology into an empty complete graph: %j", async (body) => {
    respond(body);
    expect(await new ApiClient("https://api.test").getIssueGraph("ws", request)).toBeNull();
  });

  it("keeps malformed summaries unknown while retaining complete topology", async () => {
    respond({ ...reference, nodes: reference.nodes.map((n) => ({ ...n, dependency_summary: {}, run_summary: "broken" })) });
    const graph = await new ApiClient("https://api.test").getIssueGraph("ws", request);
    expect(graph?.nodes).toHaveLength(14);
    expect(graph?.nodes[0]?.runSummary).toBeNull();
    expect(issueGraphReadiness(graph?.nodes[0]?.dependencySummary)).toBe("unknown");
    expect(issueGraphReadiness({ dependencyVersion: "v", visibleUnsatisfiedCount: 0, hasRestrictedBlockers: true })).toBe("blocked");
  });

  it.each([403, 404, 405, 422, 500])("surfaces HTTP %i without falling back to a list", async (status) => {
    const fetch = respond({ error: "unavailable" }, status);
    await expect(new ApiClient("https://api.test").getIssueGraph("ws", request)).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
