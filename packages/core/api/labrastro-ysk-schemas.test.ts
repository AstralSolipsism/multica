// @vitest-environment node

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import {
  isTipShownToMe,
  IssueTip,
  IssueTipListSchema,
  IssueTipSchema,
} from "./labrastro-ysk-schemas";
import type { IssueTipChangedPayload } from "../types";

const client = new ApiClient("https://api.example.test");

function respond(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

// Matches the OL-188 server response (PR #95 labrastroTipResponse JSON tags).
const tip = {
  id: "t1",
  workspace_id: "ws-1",
  issue_id: "i1",
  issue_identifier: "LAB-1",
  task_id: "r1",
  agent_id: "a1",
  anchor_comment_id: null,
  tag: "you_should_know",
  line: "The deploy script drops the db",
  title: "",
  explanation: "",
  status: "valid",
  overturned_by_task_id: null,
  overturned_by_comment_id: null,
  overturned_reason: null,
  user_state: undefined,
  created_at: "2026-10-11T00:00:00Z",
  updated_at: "2026-10-11T00:00:00Z",
};

describe("issue tip list schema", () => {
  it("drops rows with unknown tag or status without failing the list", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [
        tip,
        { ...tip, id: "t2", tag: "future_tag" },
        { ...tip, id: "t3", status: "future_status" },
      ],
    });
    expect(parsed.tips.map((t) => t.id)).toEqual(["t1"]);
  });

  it("drops a row whose line is missing (no empty-bodied bubbles)", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [tip, { ...tip, id: "t2", line: undefined }],
    });
    expect(parsed.tips.map((t) => t.id)).toEqual(["t1"]);
  });

  it("defaults missing optional fields and normalizes empty strings to null", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [{
        id: "t1",
        workspace_id: "ws-1",
        issue_id: "i1",
        issue_identifier: "LAB-1",
        task_id: "r1",
        agent_id: "a1",
        tag: "heads_up",
        line: "x",
        status: "valid",
      }],
    });
    expect(parsed.tips[0]).toMatchObject({
      anchor_comment_id: null,
      title: null,
      explanation: null,
      overturned_by_task_id: null,
      overturned_reason: null,
      user_state: null,
      created_at: "",
    });
  });

  it("keeps a known user_state, normalizes an omitted one to null", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [
        { ...tip, user_state: { state: "known", feedback: "helpful" } },
        tip,
      ],
    });
    expect(parsed.tips[0]?.user_state).toEqual({ state: "known", feedback: "helpful" });
    expect(parsed.tips[1]?.user_state).toBeNull();
  });

  it("degrades only an unknown feedback, keeping the state readable", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [
        { ...tip, user_state: { state: "dismissed", feedback: "meh" } },
      ],
    });
    // The tip stays dismissed — a user who acted on it must not see it again.
    expect(parsed.tips[0]?.user_state).toEqual({ state: "dismissed", feedback: null });
  });

  it("isTipShownToMe only for valid tips without user_state", () => {
    expect(isTipShownToMe({ status: "valid", user_state: null })).toBe(true);
    expect(isTipShownToMe({ status: "overturned", user_state: null })).toBe(false);
    expect(isTipShownToMe({ status: "valid", user_state: { state: "known", feedback: null } })).toBe(false);
  });

  it("a WS event's raw tip is not assignable to a parsed IssueTip (parse before caching)", () => {
    // OL-211: the server omits `user_state` when the viewer has not acted, so
    // the raw payload's user_state is `undefined`, not `null`. If this guard
    // regressed (payload tip typed as parsed IssueTip), writing payload.tip
    // straight into a cache would make isTipShownToMe see undefined !== null
    // and hide every fresh tip. expectTypeOf fails compilation on regression.
    const payload = {
      tip: { ...tip, tag: "you_should_know" as const, status: "valid" as const },
    } satisfies IssueTipChangedPayload;
    expectTypeOf(payload.tip).not.toMatchTypeOf<IssueTip>();
    // Parsing is the sanctioned bridge from wire to cache…
    expectTypeOf(IssueTipSchema.parse(payload.tip)).toEqualTypeOf<IssueTip>();
    // …and it normalizes the absent key the display logic depends on.
    expect(IssueTipSchema.parse(payload.tip).user_state).toBeNull();
  });
});

describe("listIssueTips", () => {
  it("requests the status filter and parses tips", async () => {
    const fetch = respond({ tips: [tip] });
    await expect(client.listIssueTips("i1", "all")).resolves.toEqual({
      tips: [{ ...tip, title: null, explanation: null, user_state: null }],
    });
    const url = fetch.mock.calls[0]?.[0];
    expect(String(url)).toBe("https://api.example.test/api/issues/i1/tips?status=all");
  });

  it.each([null, {}, { tips: "bad" }, [[]]])(
    "rejects an unreadable response: %j",
    async (body) => {
      respond(body);
      const error = await client.listIssueTips("i1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).body).toMatchObject({ code: "response_unreadable" });
    },
  );
});

describe("listActiveTips", () => {
  it("parses the active list", async () => {
    const fetch = respond({ tips: [tip] });
    await expect(client.listActiveTips()).resolves.toEqual({
      tips: [{ ...tip, title: null, explanation: null, user_state: null }],
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.example.test/api/tips/active");
  });

  it("rejects an unreadable response", async () => {
    respond([]);
    await expect(client.listActiveTips()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("setTipState", () => {
  it("posts the state payload", async () => {
    const fetch = respond({});
    await client.setTipState("t1", { state: "known", feedback: null });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toBe("https://api.example.test/api/tips/t1/state");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ state: "known", feedback: null });
  });

  it("preserves HTTP failures", async () => {
    respond({ error: "nope" }, 503);
    await expect(client.setTipState("t1", { state: "dismissed", feedback: null })).rejects.toBeInstanceOf(ApiError);
  });
});
