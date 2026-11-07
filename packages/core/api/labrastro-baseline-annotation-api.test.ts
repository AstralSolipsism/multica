// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const id = "00000000-0000-4000-8000-000000000001";

afterEach(() => vi.unstubAllGlobals());

const operations: Array<{
  method: string;
  path: string;
  body?: unknown;
  call: (api: ApiClient) => Promise<unknown>;
}> = [
  {
    method: "GET",
    path: "/api/projects/project%2Fid/baseline/annotation-batches?chapter=domain_rules&state=active&issue_id=issue%2F1",
    call: (api) => api.getProjectBaselineAnnotationBatches("ws-1", "project/id", {
      chapter: "domain_rules", state: "active", issueId: "issue/1",
    }),
  },
  {
    method: "GET",
    path: "/api/projects/project%2Fid/baseline/annotation-batches/batch%2F1?state=all&with_sections=true",
    call: (api) => api.getProjectBaselineAnnotationBatch("ws-1", "project/id", "batch/1", {
      state: "all", withSections: true,
    }),
  },
  {
    method: "POST",
    path: "/api/projects/project%2Fid/baseline/reviews",
    body: {
      client_key: "client-1",
      chapter: "domain_rules",
      reviewed_revision_id: "reviewed-1",
      assignee: { type: "agent", id: "agent-1" },
      summary: "Please revise",
      annotations: [
        {
          anchor_kind: "lines",
          target_revision_id: "revision-1",
          section_anchor: "RULE-1",
          section_title: "Settlement",
          line_start: 2,
          line_end: 4,
          quote: "one\ntwo\nthree",
          prefix: "before",
          suffix: "after",
          start: 3,
          note: "Clarify this",
        },
        {
          anchor_kind: "section",
          target_revision_id: "revision-1",
          parent_annotation_id: "parent-1",
          section_anchor: "RULE-1",
          section_title: "Settlement",
          note: "A follow-up",
        },
      ],
    },
    call: (api) => api.submitProjectBaselineReview("ws-1", "project/id", {
      clientKey: "client-1",
      chapter: "domain_rules",
      reviewedRevisionId: "reviewed-1",
      assignee: { type: "agent", id: "agent-1" },
      summary: "Please revise",
      annotations: [
        {
          anchorKind: "lines",
          targetRevisionId: "revision-1",
          sectionAnchor: "RULE-1",
          sectionTitle: "Settlement",
          lineStart: 2,
          lineEnd: 4,
          quote: "one\ntwo\nthree",
          prefix: "before",
          suffix: "after",
          start: 3,
          note: "Clarify this",
        },
        {
          anchorKind: "section",
          targetRevisionId: "revision-1",
          parentAnnotationId: "parent-1",
          sectionAnchor: "RULE-1",
          sectionTitle: "Settlement",
          note: "A follow-up",
        },
      ],
    }),
  },
  {
    method: "POST",
    path: "/api/projects/project%2Fid/baseline/annotations/resolve",
    body: { annotation_ids: ["annotation-1", "annotation-2"], resolved: false },
    call: (api) => api.resolveProjectBaselineAnnotations("ws-1", "project/id", {
      annotationIds: ["annotation-1", "annotation-2"], resolved: false,
    }),
  },
  {
    method: "POST",
    path: "/api/projects/project%2Fid/baseline/annotation-batches/batch%2F1/close",
    call: (api) => api.closeProjectBaselineAnnotationBatch("ws-1", "project/id", "batch/1"),
  },
];

it.each(operations)("$method $path sends the contract and falls back on malformed responses", async ({ method, path, body, call }) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ malformed: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetcher);

  expect(await call(new ApiClient("https://example.test"))).toBeNull();

  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`https://example.test${path}`);
  expect(init.method ?? "GET").toBe(method);
  expect(new Headers(init.headers).get("X-Workspace-ID")).toBe("ws-1");
  expect(new Headers(init.headers).get("X-Workspace-Slug")).toBe("");
  expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
});

it("parses installed batch list responses into camelCase data", async () => {
  const batch = {
    id,
    workspace_id: id,
    project_id: id,
    chapter: "domain_rules",
    carrier_kind: "revision_issue",
    agent_id: id,
    created_by_id: id,
    created_at: "2026-11-06T00:00:00Z",
    state: "active",
    carrier: { kind: "revision_issue", issue_id: id },
    counts: { open: 1, resolved: 0 },
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ batches: [batch] }))));

  const result = await new ApiClient("https://example.test").getProjectBaselineAnnotationBatches("ws-1", "project-1");

  expect(result?.batches[0]).toMatchObject({
    id,
    workspaceId: id,
    projectId: id,
    chapter: "domain_rules",
    carrier: { issueId: id },
    working: null,
  });
});
