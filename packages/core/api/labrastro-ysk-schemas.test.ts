// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { isTipShownToMe, IssueTipListSchema } from "./labrastro-ysk-schemas";

const client = new ApiClient("https://api.example.test");

function respond(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

const tip = {
  id: "t1",
  issue_id: "i1",
  task_id: "r1",
  agent_id: "a1",
  anchor_comment_id: null,
  tag: "you_should_know",
  line: "The deploy script drops the db",
  title: null,
  explanation: null,
  status: "valid",
  overturned_by_task_id: null,
  overturned_by_comment_id: null,
  overturn_reason: null,
  my_state: null,
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

  it("defaults missing optional fields", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [{ id: "t1", issue_id: "i1", task_id: "r1", agent_id: "a1", tag: "heads_up", line: "x", status: "valid" }],
    });
    expect(parsed.tips[0]).toMatchObject({
      anchor_comment_id: null,
      title: null,
      explanation: null,
      overturned_by_task_id: null,
      overturn_reason: null,
      my_state: null,
      created_at: "",
    });
  });

  it("keeps a known my_state and nulls an unreadable one", () => {
    const parsed = IssueTipListSchema.parse({
      tips: [
        { ...tip, my_state: { state: "known", feedback: "helpful" } },
        { ...tip, id: "t2", my_state: { state: "wat" } },
      ],
    });
    expect(parsed.tips[0]?.my_state).toEqual({ state: "known", feedback: "helpful" });
    expect(parsed.tips[1]?.my_state).toBeNull();
  });

  it("isTipShownToMe only for valid tips without my_state", () => {
    expect(isTipShownToMe({ status: "valid", my_state: null })).toBe(true);
    expect(isTipShownToMe({ status: "overturned", my_state: null })).toBe(false);
    expect(isTipShownToMe({ status: "valid", my_state: { state: "known", feedback: null } })).toBe(false);
  });
});

describe("listIssueTips", () => {
  it("requests the status filter and parses tips", async () => {
    const fetch = respond({ tips: [tip] });
    await expect(client.listIssueTips("i1", "all")).resolves.toEqual({ tips: [tip] });
    const url = fetch.mock.calls[0]?.[0];
    expect(String(url)).toBe("https://api.example.test/api/issues/i1/tips?status=all");
  });

  it.each([null, {}, { tips: "bad" }, []])(
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
    await expect(client.listActiveTips()).resolves.toEqual({ tips: [tip] });
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
