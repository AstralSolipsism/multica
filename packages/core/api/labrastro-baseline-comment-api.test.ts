// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { WikiThreadSchema, type WikiCommentAnchor } from "./labrastro-baseline-comment-schemas";

const anchor: WikiCommentAnchor = { kind: "text", sectionAnchor: "A", sectionTitle: "A", exact: "needle", prefix: "", suffix: "", start: 2, revisionNumber: 3 };
const wireThread = { id: "t", page_id: "p", anchor: { kind: "text", section_anchor: "A", exact: "needle", revision_number: 3 }, location: { state: "anchored", section_anchor: "A", start: 2 }, created_at: "now", updated_at: "now", comments: [{ id: "c", author_type: "agent", author_id: "a", body_markdown: "reply", created_at: "now" }] };
const api = new ApiClient("https://example.test");
const stub = (body: unknown) => {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", mock); return mock;
};
afterEach(() => vi.unstubAllGlobals());

it("serializes selectors and preserves structured wake outcomes", async () => {
  const mock = stub({ thread: wireThread, woke: [{ target_type: "agent", target_id: "a", status: "blocked", reason_code: "invocation_not_allowed" }] });
  const result = await api.createProjectWikiThread("ws", "project", "page", anchor, "body");
  expect(result?.woke[0]).toMatchObject({ targetType: "agent", targetId: "a", status: "blocked", reasonCode: "invocation_not_allowed" });
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("/api/projects/project/baseline/pages/page/threads");
  expect(new Headers(init.headers).get("X-Workspace-ID")).toBe("ws");
  expect(JSON.parse(init.body as string)).toMatchObject({ body_markdown: "body", anchor: { section_anchor: "A", revision_number: 3, start: 2 } });
});

it("uses safe defaults for additive enum values without dropping a thread", () => {
  const parsed = WikiThreadSchema.parse({ ...wireThread, location: { state: "new-state" } });
  expect(parsed.location.state).toBe("orphaned");
  expect(parsed.resolvedAt).toBeNull();
  expect(parsed.comments[0]?.authorTaskId).toBeNull();
});

it.each([null, {}, { threads: "bad" }, { threads: [wireThread, { id: "broken" }] }])("rejects malformed thread lists: %j", async (body) => {
  stub(body);
  expect(await api.getProjectWikiThreads("ws", "project", "page")).toBeNull();
});

it("validates every read and mutation response", async () => {
  stub({ thread: { id: "bad" }, ok: "yes" });
  expect(await api.getProjectWikiThread("ws", "project", "t", true)).toBeNull();
  expect(await api.replyProjectWikiThread("ws", "project", "t", "body")).toBeNull();
  expect(await api.createProjectWikiThread("ws", "project", "p", anchor, "body")).toBeNull();
  expect(await api.editProjectWikiComment("ws", "project", "c", "body")).toBeNull();
  expect(await api.deleteProjectWikiComment("ws", "project", "c")).toBeNull();
  expect(await api.resolveProjectWikiThread("ws", "project", "t", false)).toBeNull();
});
