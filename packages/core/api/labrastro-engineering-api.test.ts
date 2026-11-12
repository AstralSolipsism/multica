// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

// The wiki surface rides the shared labrastro transport; pin request shapes
// and payload serialization for the write paths.
function stub(body: Record<string, unknown>, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

const workspaceHeaders = { "X-Workspace-ID": "ws-1", "X-Workspace-Slug": "" };

afterEach(() => vi.unstubAllGlobals());

describe("wiki api methods", () => {
  it("posts a page create with the wire payload", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      stub({ page: { id: "00000000-0000-4000-8000-000000000001", slug: "overview", title: "T", position: 0, current_revision_number: 1 }, revision: { id: "00000000-0000-4000-8000-000000000002", page_id: "00000000-0000-4000-8000-000000000001", revision_number: 1, revision_kind: "create", title: "T", slug: "overview", created_by_type: "member", created_by_id: "00000000-0000-4000-8000-000000000009", created_at: "2026-11-12T00:00:00Z" }, rebased: false }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("https://example.test");

    const result = await api.createProjectWikiPage("ws-1", "p-1", {
      title: "T", slug: "overview", contentMarkdown: "# T", sourceIssueId: "00000000-0000-4000-8000-000000000009",
    });
    expect(result?.page.slug).toBe("overview");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/projects/p-1/baseline/pages");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "T", slug: "overview", parent: undefined, after: undefined,
      content_markdown: "# T", change_summary: undefined, source_issue_id: "00000000-0000-4000-8000-000000000009",
    });
  });

  it("puts a section write with the base revision", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      stub({ page: { id: "00000000-0000-4000-8000-000000000001", slug: "a", title: "A", position: 0, current_revision_number: 5 }, revision: { id: "00000000-0000-4000-8000-000000000003", page_id: "00000000-0000-4000-8000-000000000001", revision_number: 6, revision_kind: "content", title: "A", slug: "a", created_by_type: "member", created_by_id: "00000000-0000-4000-8000-000000000009", created_at: "2026-11-12T00:00:00Z" }, rebased: true }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("https://example.test");

    const result = await api.writeProjectWikiPage("ws-1", "p-1", "a", {
      baseRevisionNumber: 4, section: "分层", contentMarkdown: "new body",
    });
    expect(result?.rebased).toBe(true);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/projects/p-1/baseline/pages/a/content");
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      base_revision_number: 4, content_markdown: "new body", section: "分层",
      delete_section: undefined, change_summary: undefined, source_issue_id: undefined,
    });
  });

  it("serializes a move with parent null for root", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      stub({ page: { id: "00000000-0000-4000-8000-000000000001", slug: "a", title: "A", position: 0, current_revision_number: 2 }, revision: { id: "00000000-0000-4000-8000-000000000003", page_id: "00000000-0000-4000-8000-000000000001", revision_number: 3, revision_kind: "move", title: "A", slug: "a", created_by_type: "member", created_by_id: "00000000-0000-4000-8000-000000000009", created_at: "2026-11-12T00:00:00Z" }, rebased: false }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("https://example.test");

    await api.moveProjectWikiPage("ws-1", "p-1", "a", { baseRevisionNumber: 2, parent: null });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string).parent).toBeNull();
  });

  it("requests links, backlinks and related issues together", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      stub({ page: { id: "00000000-0000-4000-8000-000000000001", slug: "a", title: "A", position: 0, current_revision_number: 1 }, revision: { id: "00000000-0000-4000-8000-000000000002", page_id: "00000000-0000-4000-8000-000000000001", revision_number: 1, revision_kind: "create", title: "A", slug: "a" }, content_markdown: "" }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("https://example.test");

    await api.getProjectWikiPage("ws-1", "p-1", "a", { with: ["links", "backlinks", "related_issues"] });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("with=links%2Cbacklinks%2Crelated_issues");
  });

  it("propagates workspace headers", async () => {
    const fetchMock = vi.fn().mockImplementation(() => stub({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("https://example.test");
    await api.getProjectWikiActivity("ws-1", "p-1");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Workspace-ID")).toBe(workspaceHeaders["X-Workspace-ID"]);
  });
});
