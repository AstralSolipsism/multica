// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

// The active route deliberately belongs to another workspace: omitting the
// empty slug override would let the server select it ahead of the pinned ID.
vi.mock("../platform/workspace-storage", () => ({ getCurrentSlug: () => "other-workspace" }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(body: unknown, status = 200) {
  // A fresh Response per call: bodies are single-read streams.
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
} {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("expected a fetch call");
  const init = (call[1] ?? {}) as RequestInit;
  return {
    url: String(call[0]),
    method: init.method ?? "GET",
    headers: (init.headers ?? {}) as Record<string, string>,
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

const WS = "ws-111";
const folder = {
  id: "folder-1",
  workspace_id: WS,
  parent_id: null,
  name: "addyosmani/agent-skills",
  package_id: "pkg-1",
  package_path: "",
  created_at: "2026-10-03T00:00:00Z",
  updated_at: "2026-10-03T00:00:00Z",
};
const pkg = {
  id: "pkg-1",
  workspace_id: WS,
  owner_repo: "addyosmani/agent-skills",
  subdirectory: "",
  source_url: "https://github.com/addyosmani/agent-skills/tree/main",
  ref: "main",
  root_folder_id: "folder-1",
  created_by: "user-1",
  revision: 1,
  candidates: [{ path: "skills/a", name: "a", description: "", digest: "sha256" }],
};
const placement = {
  workspace_id: WS,
  skill_id: "skill-1",
  folder_id: "folder-1",
  package_id: "pkg-1",
  source_path: "skills/a",
};
const candidate = {
  path: "skills/a",
  name: "a",
  description: "A skill",
  default_selected: true,
  state: "new",
  can_write: true,
  digest: "sha256",
  file_count: 2,
  bytes: 1234,
  shared_files: [],
  diagnostics: [],
};
const preview = {
  preview_id: "token-1",
  source: {
    url: "https://github.com/addyosmani/agent-skills/tree/main",
    owner_repo: "addyosmani/agent-skills",
    subdirectory: "",
    ref: "main",
    revision: "abc123",
  },
  candidates: [candidate],
  diagnostics: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skill package API workspace pinning", () => {
  it.each([
    { name: "importSkillParsed", call: (c: ApiClient) => c.importSkillParsed(WS, { url: "https://github.com/o/r" }) },
    { name: "getSkillFolderTree", call: (c: ApiClient) => c.getSkillFolderTree(WS) },
    { name: "listSkillPackages", call: (c: ApiClient) => c.listSkillPackages(WS) },
    { name: "getSkillPackage", call: (c: ApiClient) => c.getSkillPackage(WS, "pkg-1") },
    { name: "previewSkillPackage", call: (c: ApiClient) => c.previewSkillPackage(WS, { url: "https://github.com/o/r" }) },
    { name: "applySkillPackage", call: (c: ApiClient) => c.applySkillPackage(WS, { preview_id: "token-1" }) },
    { name: "rescanSkillPackage", call: (c: ApiClient) => c.rescanSkillPackage(WS, "pkg-1") },
    { name: "applySkillPackageRescan", call: (c: ApiClient) => c.applySkillPackageRescan(WS, "pkg-1", { preview_id: "token-1" }) },
    { name: "getSkillPackageDeletePreview", call: (c: ApiClient) => c.getSkillPackageDeletePreview(WS, "pkg-1") },
    { name: "dissolveSkillPackage", call: (c: ApiClient) => c.dissolveSkillPackage(WS, "pkg-1", "token-1") },
    { name: "deleteSkillPackage", call: (c: ApiClient) => c.deleteSkillPackage(WS, "pkg-1", "token-1") },
    { name: "createSkillFolder", call: (c: ApiClient) => c.createSkillFolder(WS, { name: "Folder" }) },
    { name: "updateSkillFolder", call: (c: ApiClient) => c.updateSkillFolder(WS, "folder-1", { name: "Folder" }) },
    { name: "deleteSkillFolder", call: (c: ApiClient) => c.deleteSkillFolder(WS, "folder-1") },
    { name: "setSkillPlacement", call: (c: ApiClient) => c.setSkillPlacement(WS, "skill-1", "folder-1") },
    { name: "detachSkillPlacement", call: (c: ApiClient) => c.detachSkillPlacement(WS, "skill-1") },
  ])("$name pins the explicit workspace even after a route switch", async ({ call }) => {
    const fetchMock = stubFetch(null);
    await call(new ApiClient("https://api.example.test"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequest(fetchMock).headers).toMatchObject({
      "X-Workspace-ID": WS, "X-Workspace-Slug": "",
    });
  });

  it("pins X-Workspace-ID and clears the slug header on tree reads", async () => {
    const fetchMock = stubFetch({ folders: [folder], placements: [placement], packages: [pkg] });
    const client = new ApiClient("https://api.example.test");
    const tree = await client.getSkillFolderTree(WS);
    const req = lastRequest(fetchMock);
    expect(req.url).toBe("https://api.example.test/api/skill-folders");
    expect(req.headers["X-Workspace-ID"]).toBe(WS);
    expect(req.headers["X-Workspace-Slug"]).toBe("");
    expect(tree?.folders).toHaveLength(1);
    expect(tree?.placements[0]?.source_path).toBe("skills/a");
    expect(tree?.packages[0]?.candidates[0]?.path).toBe("skills/a");
  });

  it("pins the workspace on mutations too", async () => {
    const fetchMock = stubFetch(folder, 201);
    const client = new ApiClient("https://api.example.test");
    await client.createSkillFolder(WS, { name: "Engineering", parent_id: "" });
    const req = lastRequest(fetchMock);
    expect(req.method).toBe("POST");
    expect(req.headers["X-Workspace-ID"]).toBe(WS);
    expect(req.body).toEqual({ name: "Engineering", parent_id: "" });
  });
});

describe("skill package API malformed responses", () => {
  it("keeps a malformed tree indeterminate instead of an empty tree", async () => {
    stubFetch({ folders: "not-an-array", placements: [], packages: [] });
    const client = new ApiClient("https://api.example.test");
    await expect(client.getSkillFolderTree(WS)).resolves.toBeNull();
  });

  it("keeps a malformed package list indeterminate instead of an empty list", async () => {
    stubFetch({ packages: "not-an-array" });
    const client = new ApiClient("https://api.example.test");
    await expect(client.listSkillPackages(WS)).resolves.toBeNull();
  });

  it("returns null when a preview is missing required fields", async () => {
    stubFetch({ candidates: [] });
    const client = new ApiClient("https://api.example.test");
    await expect(
      client.previewSkillPackage(WS, { url: "https://github.com/o/r" }),
    ).resolves.toBeNull();
  });

  it("tolerates unknown extra response fields (forward compatibility)", async () => {
    stubFetch({
      folders: [{ ...folder, future_field: { nested: true } }],
      placements: [],
      packages: [],
      future_top_level: 42,
    });
    const client = new ApiClient("https://api.example.test");
    const tree = await client.getSkillFolderTree(WS);
    expect(tree?.folders[0]?.id).toBe("folder-1");
  });

  it("keeps HTTP failures as thrown errors, never a parsed fallback", async () => {
    stubFetch({ error: "boom", code: "operation_failed" }, 500);
    const client = new ApiClient("https://api.example.test");
    await expect(client.getSkillFolderTree(WS)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("skill package preview/apply parsing", () => {
  it("parses a preview and strips selectability from unknown candidate states", async () => {
    stubFetch({
      ...preview,
      candidates: [
        candidate,
        { ...candidate, path: "skills/b", name: "b", state: "brand-new-state", can_write: true, default_selected: true },
      ],
    });
    const client = new ApiClient("https://api.example.test");
    const result = await client.previewSkillPackage(WS, { url: "https://github.com/o/r" });
    expect(result?.candidates[0]?.state).toBe("new");
    const unknown = result?.candidates[1];
    expect(unknown?.state).toBe("unknown");
    expect(unknown?.can_write).toBe(false);
    expect(unknown?.default_selected).toBe(false);
  });

  it("forces failed:true when any apply item failed, even if the server says otherwise", async () => {
    stubFetch({
      package: pkg,
      results: [
        { path: "skills/a", status: "created", skill_id: "skill-1", retryable: false, diagnostics: [] },
        { path: "skills/b", status: "failed", code: "name_conflict", reason: "taken", retryable: true, diagnostics: [] },
      ],
      failed: false,
      diagnostics: [],
    });
    const client = new ApiClient("https://api.example.test");
    const result = await client.applySkillPackage(WS, {
      url: "https://github.com/o/r",
      preview_id: "token-1",
      skills: ["skills/a"],
      on_conflict: "skip",
    });
    expect(result?.failed).toBe(true);
    expect(result?.results[1]?.code).toBe("name_conflict");
  });

  it("treats an unknown apply item status as unsuccessful", async () => {
    stubFetch({
      results: [{ path: "skills/a", status: "teleported", retryable: false, diagnostics: [] }],
      failed: false,
      diagnostics: [],
    });
    const client = new ApiClient("https://api.example.test");
    const result = await client.applySkillPackage(WS, { preview_id: "token-1" });
    expect(result?.results[0]?.status).toBe("unknown");
    expect(result?.failed).toBe(true);
  });

  it("keeps a malformed apply result indeterminate", async () => {
    stubFetch({ results: "oops", failed: false });
    const client = new ApiClient("https://api.example.test");
    await expect(client.applySkillPackage(WS, { preview_id: "token-1" })).resolves.toBeNull();
  });
});

describe("skill package route coverage", () => {
  it("rescan posts an empty body by default and the URL override when given", async () => {
    const fetchMock = stubFetch(preview);
    const client = new ApiClient("https://api.example.test");
    await client.rescanSkillPackage(WS, "pkg-1");
    expect(lastRequest(fetchMock).body).toEqual({});
    await client.rescanSkillPackage(WS, "pkg-1", { url: "https://github.com/o/r/tree/dev" });
    expect(lastRequest(fetchMock).body).toEqual({ url: "https://github.com/o/r/tree/dev" });
    expect(lastRequest(fetchMock).url).toBe("https://api.example.test/api/skill-packages/pkg-1/rescan");
  });

  it("rescan apply sends apply:true with the selection", async () => {
    const fetchMock = stubFetch({ results: [], failed: false, diagnostics: [] });
    const client = new ApiClient("https://api.example.test");
    const result = await client.applySkillPackageRescan(WS, "pkg-1", {
      preview_id: "token-2",
      all: true,
      on_conflict: "rename",
    });
    expect(lastRequest(fetchMock).body).toEqual({ preview_id: "token-2", all: true, on_conflict: "rename", apply: true });
    expect(result?.failed).toBe(false);
  });

  it("delete-preview parses and stays indeterminate when malformed", async () => {
    const client = new ApiClient("https://api.example.test");
    stubFetch({ preview_id: "t", skill_ids: ["s1"], affected_agents: [{ id: "a1", name: "Agent", skill_id: "s1", skill_name: "a" }], can_delete: true });
    const ok = await client.getSkillPackageDeletePreview(WS, "pkg-1");
    expect(ok?.affected_agents[0]?.skill_name).toBe("a");
    stubFetch({ skill_ids: [] });
    await expect(client.getSkillPackageDeletePreview(WS, "pkg-1")).resolves.toBeNull();
  });

  it("dissolve and delete reject contradictory removed markers", async () => {
    const client = new ApiClient("https://api.example.test");
    stubFetch({ deleted: false, dissolved: true, skill_count: 2 });
    await expect(client.dissolveSkillPackage(WS, "pkg-1", "t")).resolves.toEqual({
      deleted: false,
      dissolved: true,
      skill_count: 2,
    });
    stubFetch({ deleted: false, dissolved: false, skill_count: 2 });
    await expect(client.deleteSkillPackage(WS, "pkg-1", "t")).resolves.toBeNull();
  });

  it("delete sends the preview token in the DELETE body", async () => {
    const fetchMock = stubFetch({ deleted: true, dissolved: false, skill_count: 1 });
    const client = new ApiClient("https://api.example.test");
    await client.deleteSkillPackage(WS, "pkg-1", "token-9");
    const req = lastRequest(fetchMock);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("https://api.example.test/api/skill-packages/pkg-1");
    expect(req.body).toEqual({ preview_id: "token-9" });
  });

  it("folder update, delete and placement routes map to the contract", async () => {
    const client = new ApiClient("https://api.example.test");

    const patchFetch = stubFetch({ ...folder, name: "Renamed" });
    await client.updateSkillFolder(WS, "folder-1", { name: "Renamed", parent_id: "folder-2" });
    expect(lastRequest(patchFetch).method).toBe("PATCH");
    expect(lastRequest(patchFetch).body).toEqual({ name: "Renamed", parent_id: "folder-2" });

    const delFetch = stubFetch({ deleted: true });
    await expect(client.deleteSkillFolder(WS, "folder-1")).resolves.toEqual({ deleted: true });
    expect(lastRequest(delFetch).method).toBe("DELETE");

    const putFetch = stubFetch({ updated: true });
    await client.setSkillPlacement(WS, "skill-1", "");
    expect(lastRequest(putFetch).method).toBe("PUT");
    expect(lastRequest(putFetch).url).toBe("https://api.example.test/api/skill-placements/skill-1");
    expect(lastRequest(putFetch).body).toEqual({ folder_id: "" });

    const detachFetch = stubFetch({ updated: true });
    await client.detachSkillPlacement(WS, "skill-1");
    expect(lastRequest(detachFetch).method).toBe("POST");
    expect(lastRequest(detachFetch).url).toBe("https://api.example.test/api/skill-placements/skill-1/detach");

    stubFetch({ updated: false });
    await expect(client.setSkillPlacement(WS, "skill-1", "folder-1")).resolves.toBeNull();
  });
});
