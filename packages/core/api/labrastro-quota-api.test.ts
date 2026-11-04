// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

const client = () => new ApiClient("https://example.test");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const source = {
  id: "source-1",
  kind: "glm",
  name: "Primary GLM",
  base_url: null,
  credential_hint: "a3f9",
  enabled: true,
  visibility: "private",
  quota: {
    provider: "glm",
    status: "ok",
    windows: [{ name: "tokens_300", used_percent: 25, window_minutes: 300, resets_at: null, group: "tokens" }],
    observed_at: 1_800_000_000,
    source: "subscription",
  },
  last_polled_at: "2027-01-01T00:00:00Z",
  last_error: null,
  created_at: "2027-01-01T00:00:00Z",
  updated_at: "2027-01-01T00:00:00Z",
};

describe("quota source response contracts", () => {
  it("falls back safely when either list response is wholly malformed", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ sources: null })));
    vi.stubGlobal("fetch", fetcher);

    await expect(client().listQuotaSources()).resolves.toEqual({
      encryption_configured: false,
      sources: [],
    });
    await expect(client().listWorkspaceQuotaSources("ws/1")).resolves.toEqual({ sources: [] });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://example.test/api/runtimes/quota-sources?workspace_id=ws%2F1",
    );
  });

  it("drops unreadable rows and degrades malformed optional fields without losing valid rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      encryption_configured: true,
      sources: [null, "bad", { ...source, id: 42 }, {
        ...source,
        base_url: 42,
        credential_hint: null,
        quota: { malformed: true },
        last_error: { code: 401, message: null },
      }],
    })));

    const result = await client().listQuotaSources();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: "source-1",
      base_url: null,
      credential_hint: "",
      last_error: { code: "", message: "" },
    });
  });

  it("keeps workspace card visibility and owner-safe error fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      sources: [{
        id: "card-1",
        kind: "zenmux",
        name: "Shared ZenMux",
        owner_id: "owner-1",
        visibility: "shared",
        is_own: false,
        quota: null,
        last_error: null,
      }],
    })));

    const result = await client().listWorkspaceQuotaSources("ws-1");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      id: "card-1",
      kind: "zenmux",
      name: "Shared ZenMux",
      owner_id: "owner-1",
      visibility: "shared",
      is_own: false,
      quota: null,
      last_error: null,
    });
  });
});

describe("quota source writes", () => {
  const operations = [
    {
      method: "POST",
      path: "/api/me/quota-sources",
      call: (api: ApiClient) => api.createQuotaSource({
        kind: "glm",
        name: "Primary GLM",
        credential: "secret-key",
        base_url: "https://open.bigmodel.cn",
        visibility: "private",
      }),
      body: {
        kind: "glm",
        name: "Primary GLM",
        credential: "secret-key",
        base_url: "https://open.bigmodel.cn",
        visibility: "private",
      },
    },
    {
      method: "PATCH",
      path: "/api/me/quota-sources/source%2F1",
      call: (api: ApiClient) => api.updateQuotaSource("source/1", { enabled: false }),
      body: { enabled: false },
      response: { ...source, id: "source/1", enabled: false },
    },
    {
      method: "POST",
      path: "/api/me/quota-sources/source%2F1/refresh",
      call: (api: ApiClient) => api.refreshQuotaSource("source/1"),
      body: undefined,
      response: { ...source, id: "source/1" },
    },
  ];

  it.each(operations)("$method $path sends the expected request", async ({ method, path, call, body, ...operation }) => {
    const response = "response" in operation ? operation.response : source;
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetcher);

    await call(client());
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://example.test${path}`);
    expect(init.method).toBe(method);
    expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
  });

  it("deletes a source and accepts the 204 response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(client().deleteQuotaSource("source/1")).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/api/me/quota-sources/source%2F1");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("rejects an unconfirmed write response instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ malformed: true })));
    await expect(client().createQuotaSource({
      kind: "zenmux",
      name: "ZenMux",
      credential: "secret-key",
      visibility: "shared",
    })).rejects.toMatchObject({ status: 0, body: { code: "response_unconfirmed" } });
  });
});
