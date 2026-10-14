// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { ChatSessionSchema } from "./schemas";

const source = {
  tip_id: "tip", issue_id: "issue", issue_identifier: "OL-123", source_task_id: "run",
  tip: { tag: "heads_up", line: "A tip", title: "Title", explanation: "Why", status: "overturned", overturned_reason: "New evidence", overturned_by_comment_id: "comment" },
};
const session = { id: "session", title: "OL-123 · Title", tip_source: source };

afterEach(() => vi.unstubAllGlobals());

describe("tip side chat API", () => {
  it("preserves the source snapshot and accepts ordinary legacy sessions", () => {
    expect(ChatSessionSchema.parse(session).tip_source).toEqual(source);
    expect(ChatSessionSchema.parse({ id: "old" }).tip_source).toBeUndefined();
  });

  it.each([null, 42, { ...source, tip: { ...source.tip, status: "future" } }, { ...source, issue_id: null }])(
    "drops malformed optional provenance without losing the conversation: %s", (tip_source) => {
      const parsed = ChatSessionSchema.parse({ ...session, tip_source });
      expect(parsed.id).toBe("session");
      expect(parsed.tip_source).toBeUndefined();
    },
  );

  it("opens with POST through the shared API transport", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(session), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const result = await new ApiClient("https://api.example.test").openTipChat("tip");
    expect(result.tip_source).toEqual(source);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/tips/tip/chat", expect.objectContaining({ method: "POST" }));
  });

  it.each([{ id: "session" }, { id: 42 }, { ...session, tip_source: {} }])(
    "rejects an unreadable open response: %s", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      await expect(new ApiClient("https://api.example.test").openTipChat("tip")).rejects.toMatchObject({ body: { code: "response_unreadable" } });
    },
  );

  it.each(["invocation_not_allowed", "agent_archived", "agent_no_runtime"])(
    "preserves the server's disabled reason: %s", async (code) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unavailable", code }), { status: 409 })));
      await expect(new ApiClient("https://api.example.test").openTipChat("tip")).rejects.toMatchObject({ status: 409, body: { code } });
    },
  );
});
