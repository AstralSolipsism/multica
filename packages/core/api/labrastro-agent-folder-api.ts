import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import {
  AgentFolderSchema, AgentFolderTreeSchema, AgentFolderDeletedSchema, AgentPlacementUpdatedSchema,
  type AgentFolder, type AgentFolderTree, type AgentFolderDeleted, type AgentPlacementUpdated,
} from "./labrastro-agent-folder-schemas";

const workspaceHeaders = (wsId: string) => ({ "X-Workspace-ID": wsId, "X-Workspace-Slug": "" });

const labrastroAgentFolderApi = {
  async getAgentFolderTree(this: ApiClient, wsId: string): Promise<AgentFolderTree | null> {
    const raw = await clientFetch<unknown>(this, "/api/agent-folders", { headers: workspaceHeaders(wsId) });
    return parseWithFallback(raw, AgentFolderTreeSchema, null, { endpoint: "GET /api/agent-folders" });
  },

  async createAgentFolder(this: ApiClient, wsId: string, data: { name: string; parentId?: string }): Promise<AgentFolder | null> {
    const raw = await clientFetch<unknown>(this, "/api/agent-folders", {
      method: "POST", headers: workspaceHeaders(wsId),
      body: JSON.stringify({ name: data.name, parent_id: data.parentId }),
    });
    return parseWithFallback(raw, AgentFolderSchema, null, { endpoint: "POST /api/agent-folders" });
  },

  async updateAgentFolder(this: ApiClient, wsId: string, folderId: string, data: { name?: string; parentId?: string }): Promise<AgentFolder | null> {
    const raw = await clientFetch<unknown>(this, `/api/agent-folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH", headers: workspaceHeaders(wsId),
      body: JSON.stringify({ name: data.name, parent_id: data.parentId }),
    });
    return parseWithFallback(raw, AgentFolderSchema, null, { endpoint: "PATCH /api/agent-folders/:id" });
  },

  async deleteAgentFolder(this: ApiClient, wsId: string, folderId: string): Promise<AgentFolderDeleted | null> {
    const raw = await clientFetch<unknown>(this, `/api/agent-folders/${encodeURIComponent(folderId)}`, {
      method: "DELETE", headers: workspaceHeaders(wsId),
    });
    return parseWithFallback(raw, AgentFolderDeletedSchema, null, { endpoint: "DELETE /api/agent-folders/:id" });
  },

  async setAgentPlacement(this: ApiClient, wsId: string, agentId: string, folderId: string): Promise<AgentPlacementUpdated | null> {
    const raw = await clientFetch<unknown>(this, `/api/agent-placements/${encodeURIComponent(agentId)}`, {
      method: "PUT", headers: workspaceHeaders(wsId), body: JSON.stringify({ folder_id: folderId }),
    });
    return parseWithFallback(raw, AgentPlacementUpdatedSchema, null, { endpoint: "PUT /api/agent-placements/:id" });
  },

  async setAgentSquadPlacement(this: ApiClient, wsId: string, squadId: string, folderId: string): Promise<AgentPlacementUpdated | null> {
    const raw = await clientFetch<unknown>(this, `/api/agent-squad-placements/${encodeURIComponent(squadId)}`, {
      method: "PUT", headers: workspaceHeaders(wsId), body: JSON.stringify({ folder_id: folderId }),
    });
    return parseWithFallback(raw, AgentPlacementUpdatedSchema, null, { endpoint: "PUT /api/agent-squad-placements/:id" });
  },
};

export type LabrastroAgentFolderApi = typeof labrastroAgentFolderApi;

export function installLabrastroAgentFolderApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroAgentFolderApi);
}
