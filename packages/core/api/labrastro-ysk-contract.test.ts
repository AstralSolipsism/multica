// @vitest-environment node

/**
 * OL-197: the You-should-know endpoints checked against a running OL-188
 * server (`make up`, tips reported through POST /api/daemon/tasks/{taskId}/tips,
 * states set from the web app). The bodies below are recorded from that server,
 * one row per case. Success bodies must parse into what the views read; the
 * errors the server really sends must reach callers as ApiError with its status
 * and message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { isTipShownToMe } from "./labrastro-ysk-schemas";

const client = new ApiClient("https://api.example.test");

function respond(body: string, status: number) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

const WS = "e605b54c-e310-4298-b39f-930e59123b53";

// GET /api/issues/YSK-36/tips?status=all — run 1 anchored on the description
// (one tip later overturned by run 2's comment), run 2 on comment 1, run 3 on
// comment 2, which was then edited.
const OVERTURNED = {
  id: "403112aa-406e-4229-bec2-3149eb7775a5", workspace_id: WS,
  issue_id: "01a1345c-6ce5-7a14-8d4f-b784efebb570", issue_identifier: "YSK-36",
  task_id: "01a1345c-6d31-774a-b02a-014d7970f40d", agent_id: "cf2f59a6-fb5b-4a8c-afa8-921b9c6db747",
  anchor_comment_id: null, tag: "you_should_know",
  line: "缓存过期时间从 10 分钟缩短到 1 分钟", title: "缩短过期时间",
  explanation: "作为兜底，详情页缓存的过期时间从 10 分钟改为 1 分钟，即使漏删也最多旧 1 分钟。",
  status: "overturned",
  overturned_by_task_id: "01a1345c-7429-75ec-997c-7cdc2432700c",
  overturned_by_comment_id: "01a1345c-741f-7a93-bdb0-af0f0397f847",
  overturned_reason: "评论要求保持 10 分钟过期时间",
  created_at: "2026-10-13T08:23:55.161321Z", updated_at: "2026-10-13T08:23:56.782278Z",
};
const VALID_ON_COMMENT = {
  id: "fefa18d8-2905-4aee-9d01-4fca496d27f7", workspace_id: WS,
  issue_id: "01a1345c-6ce5-7a14-8d4f-b784efebb570", issue_identifier: "YSK-36",
  task_id: "01a1345c-7429-75ec-997c-7cdc2432700c", agent_id: "cf2f59a6-fb5b-4a8c-afa8-921b9c6db747",
  anchor_comment_id: "01a1345c-741f-7a93-bdb0-af0f0397f847", tag: "you_should_know",
  line: "过期时间保持 10 分钟，只靠主动删除保证新鲜", title: "保持 10 分钟",
  explanation: "按评论要求不再缩短过期时间，新鲜度完全依赖价格变更时的主动删除。",
  status: "valid", overturned_by_task_id: null, overturned_by_comment_id: null, overturned_reason: null,
  created_at: "2026-10-13T08:23:56.782278Z", updated_at: "2026-10-13T08:23:56.782278Z",
};
const SOURCE_CHANGED = {
  id: "3ae371f9-b2b2-4dda-bb09-1a317de67a13", workspace_id: WS,
  issue_id: "01a1345c-6ce5-7a14-8d4f-b784efebb570", issue_identifier: "YSK-36",
  task_id: "01a1345c-7a80-7646-9f4c-9abf1f59504c", agent_id: "cf2f59a6-fb5b-4a8c-afa8-921b9c6db747",
  anchor_comment_id: "01a1345c-7a62-777f-a316-1f60878ebfff", tag: "heads_up",
  line: "批量改价的删除放在异步任务里，会有几秒延迟", title: "删除有延迟",
  explanation: "为了不拖慢批量接口，删除缓存放进了异步任务。改价后的几秒内，详情页可能还显示旧价格。",
  status: "source_changed", overturned_by_task_id: null, overturned_by_comment_id: null, overturned_reason: null,
  created_at: "2026-10-13T08:23:58.412815Z", updated_at: "2026-10-13T08:25:19.652346Z",
};
// GET /api/tips/active — one tip the viewer dismissed with feedback, one untouched.
const DISMISSED = {
  id: "9e20ebfa-050a-4243-b805-b60c7d90646e", workspace_id: WS,
  issue_id: "01a13443-5753-7199-a7d7-66a7c954103a", issue_identifier: "YSK-5",
  task_id: "01a13443-5756-777f-94f7-5a95035e6ee3", agent_id: "06c82504-2e81-4efc-90a7-9adac0e7c11f",
  anchor_comment_id: null, tag: "you_should_know",
  line: "验证码输入框支持直接粘贴 6 位数字", title: "支持粘贴验证码",
  explanation: "粘贴 6 位验证码会自动分到 6 个格子里，不用一位一位输入。",
  status: "valid", overturned_by_task_id: null, overturned_by_comment_id: null, overturned_reason: null,
  created_at: "2026-10-13T07:56:31.125425Z", updated_at: "2026-10-13T07:56:31.125425Z",
  user_state: { state: "dismissed", feedback: "not_relevant", updated_at: "2026-10-13T08:19:18.016662Z" },
};
const UNTOUCHED = {
  id: "cebb766d-cf92-41a3-ac12-8b0b79b41b73", workspace_id: WS,
  issue_id: "01a13464-93ba-7e64-9853-7d6ed89b9a15", issue_identifier: "YSK-38",
  task_id: "01a13464-93c3-7b3c-8ce2-40d69f527899", agent_id: "06c82504-2e81-4efc-90a7-9adac0e7c11f",
  anchor_comment_id: null, tag: "heads_up",
  line: "The agent removed the old XML example", title: "XML removed",
  explanation: "The XML callback format is no longer documented. Partners still on XML will need the archived docs.",
  status: "valid", overturned_by_task_id: null, overturned_by_comment_id: null, overturned_reason: null,
  created_at: "2026-10-13T08:35:53.984447Z", updated_at: "2026-10-13T08:35:53.984447Z",
};

describe("recorded OL-188 responses", () => {
  it("parses an issue's full archive: valid, overturned and source-changed rows", async () => {
    respond(JSON.stringify({ tips: [SOURCE_CHANGED, VALID_ON_COMMENT, OVERTURNED] }), 200);
    const { tips } = await client.listIssueTips("YSK-36", "all");
    expect(tips.map((tip) => [tip.status, tip.tag, tip.anchor_comment_id, tip.user_state])).toEqual([
      ["source_changed", "heads_up", SOURCE_CHANGED.anchor_comment_id, null],
      ["valid", "you_should_know", VALID_ON_COMMENT.anchor_comment_id, null],
      ["overturned", "you_should_know", null, null],
    ]);
    expect(tips[2]).toMatchObject({
      title: "缩短过期时间",
      overturned_by_task_id: OVERTURNED.overturned_by_task_id,
      overturned_by_comment_id: OVERTURNED.overturned_by_comment_id,
      overturned_reason: OVERTURNED.overturned_reason,
    });
  });

  it("parses the active list with the viewer's state", async () => {
    respond(JSON.stringify({ tips: [UNTOUCHED, DISMISSED] }), 200);
    const { tips } = await client.listActiveTips();
    expect(tips[1]?.user_state).toMatchObject({ state: "dismissed", feedback: "not_relevant" });
    expect(tips.map(isTipShownToMe)).toEqual([true, false]);
  });

  it("accepts the state payload POST /api/tips/{tipId}/state answers with", async () => {
    respond(JSON.stringify({
      feedback: null, issue_id: "01a13443-5749-78aa-8ecf-98ef7d5012f2", state: "known",
      tip_id: "e9eca585-0ed8-40f5-9db5-9538a6052ddb", updated_at: "2026-10-13T08:53:16.242267Z",
      user_id: "146ce110-281d-4111-85a7-3d834b637aef", workspace_id: WS,
    }), 200);
    await expect(
      client.setTipState("e9eca585-0ed8-40f5-9db5-9538a6052ddb", { state: "known", feedback: null }),
    ).resolves.toBeUndefined();
  });
});

describe("recorded OL-188 error responses", () => {
  const humanOnly = '{"error":"this endpoint is only available to human actors"}';
  const noRoute = "404 page not found\n"; // a server without OL-188
  it.each([
    ["listIssueTips", () => client.listIssueTips("missing"), 404, '{"error":"issue not found"}', "issue not found"],
    ["listIssueTips", () => client.listIssueTips("YSK-1"), 403, humanOnly, "this endpoint is only available to human actors"],
    ["listIssueTips", () => client.listIssueTips("YSK-1"), 404, noRoute, "API error: 404 "],
    ["listActiveTips", () => client.listActiveTips(), 401, '{"error":"missing authorization"}', "missing authorization"],
    ["listActiveTips", () => client.listActiveTips(), 403, humanOnly, "this endpoint is only available to human actors"],
    ["listActiveTips", () => client.listActiveTips(), 404, '{"error":"workspace not found"}', "workspace not found"],
    ["listActiveTips", () => client.listActiveTips(), 404, noRoute, "API error: 404 "],
    ["setTipState", () => client.setTipState("gone", { state: "known", feedback: null }), 404, '{"error":"tip or source not found"}', "tip or source not found"],
    ["setTipState", () => client.setTipState("not-a-uuid", { state: "known", feedback: null }), 400, '{"error":"invalid tip_id"}', "invalid tip_id"],
    ["setTipState", () => client.setTipState("t1", { state: "dismissed", feedback: "helpful" }), 400, '{"error":"invalid tip state or feedback"}', "invalid tip state or feedback"],
    ["setTipState", () => client.setTipState("t1", { state: "known", feedback: null }), 403, humanOnly, "this endpoint is only available to human actors"],
    ["setTipState", () => client.setTipState("t1", { state: "known", feedback: null }), 404, noRoute, "API error: 404 "],
  ] as const)("%s: %i %s", async (_method, call, status, body, message) => {
    respond(body, status);
    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });
});
