// @vitest-environment node

import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const client = new ApiClient("https://api.example.test");
const window = { type: "TOKENS_LIMIT", used_percent: 20, resets_at: 1_800_000_000 };
const snapshot = { level: "pro", windows: [window], observed_at: 1_790_000_000 };

function respond(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

it("parses the account-level quota endpoint without inventing optional values", async () => {
  const body = { enabled: true, quota: snapshot, stale: true, anchor_device: "device-1" };
  const fetch = respond(body);
  await expect(client.getGlmQuota()).resolves.toEqual(body);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example.test/api/glm-quota");
});

it.each([null, {}, [], { enabled: "true" }])("hides an unreadable quota response: %j", async (body) => {
  respond(body);
  await expect(client.getGlmQuota()).resolves.toEqual({ enabled: false });
});

it.each([null, {}, { ...snapshot, windows: "broken" }, { ...snapshot, observed_at: "yesterday" }])(
  "keeps an unreadable snapshot unknown: %j", async (quota) => {
    respond({ enabled: true, quota });
    await expect(client.getGlmQuota()).resolves.toEqual({ enabled: true, quota: null });
  },
);

it.each([null, {}, { type: 42 }, { ...window, used_percent: "20" }, { ...window, remaining: "many" }])(
  "isolates an unreadable window: %j", async (badWindow) => {
    const futureWindow = { type: "FUTURE_LIMIT", remaining: 2, usage: 10 };
    respond({ enabled: true, quota: { ...snapshot, windows: [window, badWindow, futureWindow] } });
    const result = await client.getGlmQuota();
    expect(result.quota?.windows).toEqual([window, futureWindow]);
  },
);

it("keeps an unconfigured server readable", async () => {
  respond({ enabled: false });
  await expect(client.getGlmQuota()).resolves.toEqual({ enabled: false });
});

it("preserves HTTP failures", async () => {
  respond({ error: "unavailable" }, 503);
  await expect(client.getGlmQuota()).rejects.toBeInstanceOf(ApiError);
});
