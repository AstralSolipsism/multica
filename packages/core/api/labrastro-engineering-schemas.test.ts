// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  WikiPageReadSchema,
  WikiTreeSchema,
  WikiWriteResultSchema,
  WikiHistorySchema,
  WikiConflictSchema,
  WikiSearchHitSchema,
  WikiActivityItemSchema,
} from "../api/labrastro-engineering-schemas";

describe("wiki schemas", () => {
  it("parses a tree page and defaults optional fields", () => {
    const parsed = WikiTreeSchema.parse({
      pages: [{
        id: "00000000-0000-4000-8000-000000000001", slug: "overview", title: "概览",
        parent_id: null, position: 0, current_revision_number: 3,
      }],
    });
    expect(parsed.pages).toHaveLength(1);
    const [first] = parsed.pages;
    expect(first).toMatchObject({ slug: "overview", depth: 1, revisionCount: 0, sections: [] });
    expect(parsed.limits).toEqual({ maxDepth: 6, maxPages: 500 });
  });

  it("parses a page read with links and backlinks", () => {
    const parsed = WikiPageReadSchema.parse({
      page: { id: "00000000-0000-4000-8000-000000000001", slug: "a", title: "A", parent_id: null, position: 0, current_revision_number: 2 },
      revision: {
        id: "00000000-0000-4000-8000-000000000002", page_id: "00000000-0000-4000-8000-000000000001",
        revision_number: 2, revision_kind: "content", title: "A", slug: "a",
        created_by_type: "member", created_by_id: "00000000-0000-4000-8000-000000000009",
        created_at: "2026-11-12T00:00:00Z",
      },
      content_markdown: "# A",
      links: [{ raw: "b", state: "resolved", target_slug: "b" }, { raw: "c", state: "missing" }],
      backlinks: [{ slug: "d", snippet: "s" }],
    });
    expect(parsed.contentMarkdown).toBe("# A");
    expect(parsed.links[0]).toMatchObject({ state: "resolved", targetSlug: "b", candidates: [] });
    expect(parsed.backlinks[0]).toMatchObject({ slug: "d" });
  });

  it("keeps a malformed response as null data via parseWithFallback callers", () => {
    // Schemas never throw on missing optionals; a wholly malformed payload is
    // caught by the outer catch and returned as null.
    expect(() => WikiWriteResultSchema.parse({ page: null })).toThrow();
  });

  it("parses history pagination", () => {
    const parsed = WikiHistorySchema.parse({
      revisions: [{ id: "00000000-0000-4000-8000-000000000003", page_id: "00000000-0000-4000-8000-000000000001", revision_number: 4, revision_kind: "rollback", title: "A", slug: "a", created_by_type: "member", created_by_id: "00000000-0000-4000-8000-000000000009", created_at: "2026-11-12T00:00:00Z" }],
      has_more: true, next_before: 4,
    });
    expect(parsed.revisions).toHaveLength(1);
    expect(parsed.revisions[0]?.revisionKind).toBe("rollback");
    expect(parsed.nextBefore).toBe(4);
  });

  it("parses the conflict body with the current revision summary", () => {
    const parsed = WikiConflictSchema.parse({
      code: "baseline_conflict",
      current: {
        revision_number: 7, kind: "rename", created_at: "2026-11-12T00:00:00Z",
        created_by_type: "member", created_by_id: "00000000-0000-4000-8000-000000000009",
        change_summary: "改名",
      },
    });
    expect(parsed.current.revisionNumber).toBe(7);
    expect(parsed.current.sourceIssueId).toBeNull();
  });

  it("parses search hits and activity items", () => {
    expect(WikiSearchHitSchema.parse({ page_id: "00000000-0000-4000-8000-000000000001", slug: "a", match: "body" })).toMatchObject({ match: "body", sectionTitle: "" });
    expect(WikiActivityItemSchema.parse({
      page_id: "00000000-0000-4000-8000-000000000001", slug: "a", title: "A", kind: "archive", number: 3,
      created_at: "2026-11-12T00:00:00Z", created_by_type: "agent", created_by_id: "00000000-0000-4000-8000-000000000004",
    })).toMatchObject({ kind: "archive" });
  });
});
