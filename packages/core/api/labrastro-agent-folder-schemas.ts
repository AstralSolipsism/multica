import { z } from "zod";

const id = z.string().uuid();

export const AgentFolderSchema = z.object({
  id,
  workspace_id: id,
  parent_id: id.nullable(),
  name: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
}).transform((folder) => ({
  id: folder.id,
  workspaceId: folder.workspace_id,
  parentId: folder.parent_id,
  name: folder.name,
  createdAt: folder.created_at,
  updatedAt: folder.updated_at,
}));

export const AgentPlacementSchema = z.object({ agent_id: id, folder_id: id })
  .transform((placement) => ({ agentId: placement.agent_id, folderId: placement.folder_id }));

export const AgentSquadFolderSchema = z.object({
  squad_id: id,
  name: z.string(),
  avatar_url: z.string().nullable().default(null),
  leader_id: id,
  creator_id: id,
  parent_id: id.nullable(),
  agent_ids: z.array(id),
}).transform((squad) => ({
  squadId: squad.squad_id,
  name: squad.name,
  avatarUrl: squad.avatar_url,
  leaderId: squad.leader_id,
  creatorId: squad.creator_id,
  parentId: squad.parent_id,
  agentIds: squad.agent_ids,
}));

export const AgentFolderTreeSchema = z.object({
  folders: z.array(AgentFolderSchema),
  placements: z.array(AgentPlacementSchema),
  squads: z.array(AgentSquadFolderSchema),
});
export const AgentFolderDeletedSchema = z.object({ deleted: z.literal(true) });
export const AgentPlacementUpdatedSchema = z.object({ updated: z.literal(true) });

export type AgentFolder = z.infer<typeof AgentFolderSchema>;
export type AgentPlacement = z.infer<typeof AgentPlacementSchema>;
export type AgentSquadFolder = z.infer<typeof AgentSquadFolderSchema>;
export type AgentFolderTree = z.infer<typeof AgentFolderTreeSchema>;
export type AgentFolderDeleted = z.infer<typeof AgentFolderDeletedSchema>;
export type AgentPlacementUpdated = z.infer<typeof AgentPlacementUpdatedSchema>;
