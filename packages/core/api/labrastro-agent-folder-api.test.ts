// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

const client = () => new ApiClient("https://example.test");
const operations = [
  { method: "GET", path: "/api/agent-folders", call: (api: ApiClient) => api.getAgentFolderTree("ws-1"), body: undefined },
  { method: "POST", path: "/api/agent-folders", call: (api: ApiClient) => api.createAgentFolder("ws-1", { name: "new" }), body: { name: "new" } },
  { method: "PATCH", path: "/api/agent-folders/f%2F1", call: (api: ApiClient) => api.updateAgentFolder("ws-1", "f/1", { parentId: "" }), body: { parent_id: "" } },
  { method: "DELETE", path: "/api/agent-folders/f%2F1", call: (api: ApiClient) => api.deleteAgentFolder("ws-1", "f/1"), body: undefined },
  { method: "PUT", path: "/api/agent-placements/a%2F1", call: (api: ApiClient) => api.setAgentPlacement("ws-1", "a/1", ""), body: { folder_id: "" } },
  { method: "PUT", path: "/api/agent-squad-placements/s%2F1", call: (api: ApiClient) => api.setAgentSquadPlacement("ws-1", "s/1", "f1"), body: { folder_id: "f1" } },
];

it.each(operations)("$method $path pins the workspace and returns null without retrying malformed responses", async ({ method, path, call, body }) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ malformed: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await call(client())).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`https://example.test${path}`);
  expect(init.method ?? "GET").toBe(method);
  const headers = new Headers(init.headers);
  expect(headers.get("X-Workspace-ID")).toBe("ws-1");
  expect(headers.get("X-Workspace-Slug")).toBe("");
  expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
});

it.each(operations.filter((op) => op.method !== "GET"))("$method $path does not retry server failures", async ({ call }) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "failed", code: "operation_failed", retryable: true }), { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(call(client())).rejects.toMatchObject({ status: 500 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
