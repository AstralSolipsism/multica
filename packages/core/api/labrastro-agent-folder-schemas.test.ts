// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import { AgentFolderDeletedSchema, AgentFolderSchema, AgentFolderTreeSchema, AgentPlacementUpdatedSchema } from "./labrastro-agent-folder-schemas";

const id = "00000000-0000-4000-8000-000000000001";
const folder = { id, workspace_id: id, parent_id: null, name: "folder", created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z" };
const squad = { squad_id: id, name: "squad", leader_id: id, creator_id: id, parent_id: null, agent_ids: [id] };
const tree = { folders: [folder], placements: [{ agent_id: id, folder_id: id }], squads: [squad] };
const parse = (raw: unknown, schema: Parameters<typeof parseWithFallback>[1]) => parseWithFallback(raw, schema, null, { endpoint: "agent folders test" });

describe("agent folder response boundary", () => {
  it("converts the wire format and defaults optional presentation fields", () => {
    expect(AgentFolderTreeSchema.parse(tree)).toEqual({
      folders: [{ id, workspaceId: id, parentId: null, name: "folder", createdAt: folder.created_at, updatedAt: folder.updated_at }],
      placements: [{ agentId: id, folderId: id }],
      squads: [{ squadId: id, name: "squad", avatarUrl: null, leaderId: id, creatorId: id, parentId: null, agentIds: [id] }],
    });
    expect(AgentFolderTreeSchema.parse({ folders: [], placements: [], squads: [] })).toEqual({ folders: [], placements: [], squads: [] });
  });

  it.each([
    null, {}, { ...tree, folders: null }, { ...tree, squads: undefined },
    { ...tree, placements: [{ agent_id: id, folder_id: "broken" }] },
    { ...tree, folders: [{ ...folder, parent_id: undefined }] },
    { ...tree, squads: [{ ...squad, agent_ids: null }] },
    { ...tree, squads: [{ ...squad, creator_id: undefined }] },
  ])("keeps a malformed tree indeterminate: %j", (raw) => {
    expect(parse(raw, AgentFolderTreeSchema)).toBeNull();
  });

  it.each([null, {}, { ...folder, id: 42 }, { ...folder, name: "" }])("does not invent a folder: %j", (raw) => {
    expect(parse(raw, AgentFolderSchema)).toBeNull();
  });

  it.each([null, {}, { updated: false }, { updated: "true" }, { deleted: false }])("does not turn an unreadable write into success: %j", (raw) => {
    expect(parse(raw, AgentPlacementUpdatedSchema)).toBeNull();
    expect(parse(raw, AgentFolderDeletedSchema)).toBeNull();
  });
});
