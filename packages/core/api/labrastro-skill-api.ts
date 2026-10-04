// Labrastro fork: skill import, package, folder and placement API.
//
// These methods used to sit inside the upstream `ApiClient` class. They live
// here so upstream `client.ts` keeps only two mount points: the import of
// `installLabrastroSkillApi` and its call after the class. The module
// augmentation below types them as ordinary `ApiClient` methods, so call
// sites (`api.getSkillFolderTree(...)`) and test mocks are unchanged.
import type { Skill } from "../types";
import type { ApiClient } from "./client";
import { parseWithFallback } from "./schema";
import { SkillSchema } from "./schemas";
import {
  SkillFolderTreeSchema,
  SkillFolderSchema,
  SkillPackageListSchema,
  SkillPackageSchema,
  SkillPackagePreviewSchema,
  SkillPackageApplySchema,
  SkillPackageDeletePreviewSchema,
  SkillPlacementUpdatedSchema,
  SkillFolderDeletedSchema,
  SkillPackageRemovedSchema,
  type SkillFolder,
  type SkillFolderTree,
  type SkillPackage,
  type SkillPackagePreview,
  type SkillPackageApplyResult,
  type SkillPackageDeletePreview,
  type SkillPackageRemoved,
  type SkillPackageRequest,
  type SkillPlacementUpdated,
  type SkillFolderDeleted,
} from "./labrastro-skill-schemas";

declare module "./client" {
  interface ApiClient {
    importSkillParsed(data: { url: string }): Promise<Skill | null>;
    getSkillFolderTree(wsId: string): Promise<SkillFolderTree | null>;
    listSkillPackages(wsId: string): Promise<SkillPackage[] | null>;
    getSkillPackage(wsId: string, packageId: string): Promise<SkillPackage | null>;
    previewSkillPackage(wsId: string, data: { url: string }): Promise<SkillPackagePreview | null>;
    applySkillPackage(wsId: string, data: SkillPackageRequest): Promise<SkillPackageApplyResult | null>;
    rescanSkillPackage(wsId: string, packageId: string, data?: { url?: string }): Promise<SkillPackagePreview | null>;
    applySkillPackageRescan(wsId: string, packageId: string, data: SkillPackageRequest): Promise<SkillPackageApplyResult | null>;
    getSkillPackageDeletePreview(wsId: string, packageId: string): Promise<SkillPackageDeletePreview | null>;
    dissolveSkillPackage(wsId: string, packageId: string, previewId: string): Promise<SkillPackageRemoved | null>;
    deleteSkillPackage(wsId: string, packageId: string, previewId: string): Promise<SkillPackageRemoved | null>;
    createSkillFolder(wsId: string, data: { name: string; parent_id?: string }): Promise<SkillFolder | null>;
    updateSkillFolder(wsId: string, folderId: string, data: { name?: string; parent_id?: string }): Promise<SkillFolder | null>;
    deleteSkillFolder(wsId: string, folderId: string): Promise<SkillFolderDeleted | null>;
    setSkillPlacement(wsId: string, skillId: string, folderId: string): Promise<SkillPlacementUpdated | null>;
    detachSkillPlacement(wsId: string, skillId: string): Promise<SkillPlacementUpdated | null>;
  }
}

type LabrastroSkillApiMethod =
  | "importSkillParsed"
  | "getSkillFolderTree"
  | "listSkillPackages"
  | "getSkillPackage"
  | "previewSkillPackage"
  | "applySkillPackage"
  | "rescanSkillPackage"
  | "applySkillPackageRescan"
  | "getSkillPackageDeletePreview"
  | "dissolveSkillPackage"
  | "deleteSkillPackage"
  | "createSkillFolder"
  | "updateSkillFolder"
  | "deleteSkillFolder"
  | "setSkillPlacement"
  | "detachSkillPlacement";

// `ApiClient.fetch` is TypeScript-private but an ordinary prototype method at
// runtime. Reusing it keeps auth, CSRF retry and error mapping identical to
// upstream calls; typing it from `ApiClient["fetch"]` makes an upstream
// rename or signature change a compile error here instead of a runtime one.
function clientFetch<T>(client: ApiClient, path: string, init?: RequestInit): Promise<T> {
  return (client as unknown as { fetch: ApiClient["fetch"] }).fetch<T>(path, init);
}

// Skill packages & folder tree (Labrastro fork). The routes select the
// workspace strictly by X-Workspace-ID: pin it and clear the slug header
// so a request follows the query's workspace even across a route switch.
// Every response parses through parseWithFallback with a null fallback —
// a malformed tree/preview/write result stays visibly indeterminate and
// must never become an empty list or a fake success.
function workspacePinnedHeaders(wsId: string): Record<string, string> {
  return { "X-Workspace-ID": wsId, "X-Workspace-Slug": "" };
}

const labrastroSkillApi: Pick<ApiClient, LabrastroSkillApiMethod> & ThisType<ApiClient> = {
  // Parsed like every other skill read: the response now carries optional
  // import diagnostics, and a malformed result must stay indeterminate
  // (null) rather than synthesizing a skill the server may not have made.
  // Upstream `importSkill` keeps its raw `Promise<Skill>` contract; the
  // fork's URL import calls this instead.
  async importSkillParsed(data: { url: string }): Promise<Skill | null> {
    const raw = await clientFetch<unknown>(this, "/api/skills/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, SkillSchema, null, {
      endpoint: "POST /api/skills/import",
    });
  },

  async getSkillFolderTree(wsId: string): Promise<SkillFolderTree | null> {
    const raw = await clientFetch<unknown>(this, "/api/skill-folders", {
      headers: workspacePinnedHeaders(wsId),
    });
    return parseWithFallback(raw, SkillFolderTreeSchema, null, {
      endpoint: "GET /api/skill-folders",
    });
  },

  async listSkillPackages(wsId: string): Promise<SkillPackage[] | null> {
    const raw = await clientFetch<unknown>(this, "/api/skill-packages", {
      headers: workspacePinnedHeaders(wsId),
    });
    const parsed = parseWithFallback<{ packages: SkillPackage[] } | null>(raw, SkillPackageListSchema, null, {
      endpoint: "GET /api/skill-packages",
    });
    return parsed ? parsed.packages : null;
  },

  async getSkillPackage(wsId: string, packageId: string): Promise<SkillPackage | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-packages/${encodeURIComponent(packageId)}`, {
      headers: workspacePinnedHeaders(wsId),
    });
    return parseWithFallback(raw, SkillPackageSchema, null, {
      endpoint: "GET /api/skill-packages/:id",
    });
  },

  async previewSkillPackage(wsId: string, data: { url: string }): Promise<SkillPackagePreview | null> {
    const raw = await clientFetch<unknown>(this, "/api/skill-packages/preview", {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, SkillPackagePreviewSchema, null, {
      endpoint: "POST /api/skill-packages/preview",
    });
  },

  async applySkillPackage(wsId: string, data: SkillPackageRequest): Promise<SkillPackageApplyResult | null> {
    const raw = await clientFetch<unknown>(this, "/api/skill-packages/apply", {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, SkillPackageApplySchema, null, {
      endpoint: "POST /api/skill-packages/apply",
    });
  },

  // Read-only rescan: returns a fresh preview for the saved source (or an
  // override URL that may only change the ref). Applying goes through
  // applySkillPackageRescan with the preview token.
  async rescanSkillPackage(wsId: string, packageId: string, data?: { url?: string }): Promise<SkillPackagePreview | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-packages/${encodeURIComponent(packageId)}/rescan`, {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify(data?.url ? { url: data.url } : {}),
    });
    return parseWithFallback(raw, SkillPackagePreviewSchema, null, {
      endpoint: "POST /api/skill-packages/:id/rescan",
    });
  },

  async applySkillPackageRescan(wsId: string, packageId: string, data: SkillPackageRequest): Promise<SkillPackageApplyResult | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-packages/${encodeURIComponent(packageId)}/rescan`, {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify({ ...data, apply: true }),
    });
    return parseWithFallback(raw, SkillPackageApplySchema, null, {
      endpoint: "POST /api/skill-packages/:id/rescan (apply)",
    });
  },

  async getSkillPackageDeletePreview(wsId: string, packageId: string): Promise<SkillPackageDeletePreview | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-packages/${encodeURIComponent(packageId)}/delete-preview`, {
      headers: workspacePinnedHeaders(wsId),
    });
    return parseWithFallback(raw, SkillPackageDeletePreviewSchema, null, {
      endpoint: "GET /api/skill-packages/:id/delete-preview",
    });
  },

  async dissolveSkillPackage(wsId: string, packageId: string, previewId: string): Promise<SkillPackageRemoved | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-packages/${encodeURIComponent(packageId)}/dissolve`, {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify({ preview_id: previewId }),
    });
    return parseWithFallback(raw, SkillPackageRemovedSchema, null, {
      endpoint: "POST /api/skill-packages/:id/dissolve",
    });
  },

  async deleteSkillPackage(wsId: string, packageId: string, previewId: string): Promise<SkillPackageRemoved | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-packages/${encodeURIComponent(packageId)}`, {
      method: "DELETE",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify({ preview_id: previewId }),
    });
    return parseWithFallback(raw, SkillPackageRemovedSchema, null, {
      endpoint: "DELETE /api/skill-packages/:id",
    });
  },

  async createSkillFolder(wsId: string, data: { name: string; parent_id?: string }): Promise<SkillFolder | null> {
    const raw = await clientFetch<unknown>(this, "/api/skill-folders", {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, SkillFolderSchema, null, {
      endpoint: "POST /api/skill-folders",
    });
  },

  async updateSkillFolder(wsId: string, folderId: string, data: { name?: string; parent_id?: string }): Promise<SkillFolder | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, SkillFolderSchema, null, {
      endpoint: "PATCH /api/skill-folders/:id",
    });
  },

  async deleteSkillFolder(wsId: string, folderId: string): Promise<SkillFolderDeleted | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-folders/${encodeURIComponent(folderId)}`, {
      method: "DELETE",
      headers: workspacePinnedHeaders(wsId),
    });
    return parseWithFallback(raw, SkillFolderDeletedSchema, null, {
      endpoint: "DELETE /api/skill-folders/:id",
    });
  },

  // An empty folder_id clears the placement (the skill becomes uncategorized);
  // detach keeps the folder but drops the package/source association.
  async setSkillPlacement(wsId: string, skillId: string, folderId: string): Promise<SkillPlacementUpdated | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-placements/${encodeURIComponent(skillId)}`, {
      method: "PUT",
      headers: workspacePinnedHeaders(wsId),
      body: JSON.stringify({ folder_id: folderId }),
    });
    return parseWithFallback(raw, SkillPlacementUpdatedSchema, null, {
      endpoint: "PUT /api/skill-placements/:skillId",
    });
  },

  async detachSkillPlacement(wsId: string, skillId: string): Promise<SkillPlacementUpdated | null> {
    const raw = await clientFetch<unknown>(this, `/api/skill-placements/${encodeURIComponent(skillId)}/detach`, {
      method: "POST",
      headers: workspacePinnedHeaders(wsId),
    });
    return parseWithFallback(raw, SkillPlacementUpdatedSchema, null, {
      endpoint: "POST /api/skill-placements/:skillId/detach",
    });
  },
};

/**
 * Installs the fork methods on `ApiClient.prototype` with the same property
 * descriptors class methods get (non-enumerable, writable, configurable).
 * Called once from `client.ts`, right after the class definition.
 */
export function installLabrastroSkillApi(target: { prototype: ApiClient }): void {
  for (const name of Object.keys(labrastroSkillApi) as LabrastroSkillApiMethod[]) {
    Object.defineProperty(target.prototype, name, {
      value: labrastroSkillApi[name],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
