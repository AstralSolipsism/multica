// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentFolderTree } from "@multica/core/api/schemas";
import {
  agentEntryFolderIds,
  agentMoveDestinations,
  collectSubtreeFolderIds,
  explorerFolders,
  folderMoveDestinations,
  placementFolderByAgentId,
  squadById,
  squadIdsByAgentId,
  squadMoveDestinations,
} from "./agent-folder-tree";

const tree: AgentFolderTree = {
  folders: [
    {
      id: "f-root",
      workspaceId: "ws-1",
      parentId: null,
      name: "Design",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "f-child",
      workspaceId: "ws-1",
      parentId: "f-root",
      name: "Research",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "f-other",
      workspaceId: "ws-1",
      parentId: null,
      name: "Design",
      createdAt: "",
      updatedAt: "",
    },
  ],
  placements: [
    { agentId: "a-placed", folderId: "f-child" },
    { agentId: "a-both", folderId: "f-root" },
  ],
  squads: [
    {
      squadId: "sq-1",
      name: "Game design",
      avatarUrl: null,
      leaderId: "a-squad",
      creatorId: "user-1",
      parentId: "f-child",
      agentIds: ["a-squad", "a-both"],
    },
    {
      squadId: "sq-2",
      name: "Empty squad",
      avatarUrl: null,
      leaderId: "a-hidden",
      creatorId: "user-2",
      parentId: null,
      agentIds: [],
    },
  ],
};

describe("explorerFolders", () => {
  it("combines custom folders and squads, marking squads managed", () => {
    const folders = explorerFolders(tree);
    expect(folders).toHaveLength(5);
    const squad = folders.find((folder) => folder.id === "sq-1");
    expect(squad).toMatchObject({
      parentId: "f-child",
      name: "Game design",
      managed: true,
    });
    const custom = folders.find((folder) => folder.id === "f-root");
    expect(custom).toMatchObject({ parentId: null, managed: false });
  });
});

describe("membership and placement lookups", () => {
  it("maps placements and squad membership per agent", () => {
    const placements = placementFolderByAgentId(tree);
    const squads = squadIdsByAgentId(tree);
    expect(placements.get("a-placed")).toBe("f-child");
    expect(squads.get("a-both")).toEqual(["sq-1"]);
    expect(squads.get("a-placed")).toBeUndefined();
  });

  it("lists every folder an agent appears in", () => {
    const placements = placementFolderByAgentId(tree);
    const squads = squadIdsByAgentId(tree);
    expect(agentEntryFolderIds("a-both", placements, squads)).toEqual([
      "f-root",
      "sq-1",
    ]);
    expect(agentEntryFolderIds("a-placed", placements, squads)).toEqual([
      "f-child",
    ]);
    expect(agentEntryFolderIds("a-loose", placements, squads)).toEqual([]);
  });
});

describe("move destinations", () => {
  const folders = explorerFolders(tree);

  it("offers agents custom folders only, sorted by full path", () => {
    const destinations = agentMoveDestinations(folders);
    expect(destinations.map((folder) => folder.id)).toEqual([
      "f-root",
      "f-other",
      "f-child",
    ]);
  });

  it("excludes the moving folder and its descendants for folder moves", () => {
    const destinations = folderMoveDestinations(folders, "f-root");
    expect(destinations.map((folder) => folder.id)).toEqual(["f-other"]);
  });

  it("offers squad folders every custom folder", () => {
    const destinations = squadMoveDestinations(folders);
    expect(destinations.map((folder) => folder.id)).toEqual([
      "f-root",
      "f-other",
      "f-child",
    ]);
    expect(destinations.some((folder) => folder.managed)).toBe(false);
  });

  it("returns an empty subtree for an unknown root", () => {
    expect(collectSubtreeFolderIds(folders, "missing").size).toBe(0);
  });
});

describe("squadById", () => {
  it("indexes squads by their folder id", () => {
    expect(squadById(tree).get("sq-2")?.name).toBe("Empty squad");
  });
});
