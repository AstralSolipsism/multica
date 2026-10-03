// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  SkillFolder,
  SkillFolderTree,
  SkillPackage,
  SkillPlacement,
} from "@multica/core/api/schemas";
import {
  buildFolderNodes,
  collectSubtreeFolderIds,
  commonCandidatePrefix,
  folderDisplayPath,
  folderMoveDestinations,
  grayCandidates,
  isCustomFolder,
  isManagedInternalFolder,
  isPackageRootFolder,
  packageForRootFolder,
  skillMatchesFolderSelection,
  skillMoveDestinations,
} from "./skill-folder-tree";

function folder(partial: Partial<SkillFolder> & { id: string }): SkillFolder {
  return {
    workspace_id: "ws-1",
    parent_id: null,
    name: partial.id,
    package_id: null,
    package_path: null,
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
    ...partial,
  };
}

function placement(partial: Partial<SkillPlacement> & { skill_id: string; folder_id: string }): SkillPlacement {
  return { workspace_id: "ws-1", package_id: null, source_path: null, ...partial };
}

function pkg(partial: Partial<SkillPackage> & { id: string }): SkillPackage {
  return {
    workspace_id: "ws-1",
    owner_repo: "o/r",
    subdirectory: "",
    source_url: "https://github.com/o/r/tree/main",
    ref: "main",
    root_folder_id: "root-f",
    created_by: "u1",
    revision: 1,
    candidates: [],
    ...partial,
  };
}

function tree(partial: Partial<SkillFolderTree>): SkillFolderTree {
  return { folders: [], placements: [], packages: [], ...partial };
}

describe("folder classification", () => {
  it("distinguishes custom, package-root and managed-internal folders", () => {
    expect(isCustomFolder(folder({ id: "a" }))).toBe(true);
    expect(isPackageRootFolder(folder({ id: "b", package_id: "p", package_path: "" }))).toBe(true);
    expect(isManagedInternalFolder(folder({ id: "c", package_id: "p", package_path: "deep" }))).toBe(true);
    expect(isManagedInternalFolder(folder({ id: "d", package_id: "p", package_path: "" }))).toBe(false);
  });
});

describe("buildFolderNodes", () => {
  it("nests children and sorts folders by name at every level", () => {
    const nodes = buildFolderNodes([
      folder({ id: "z", name: "zeta" }),
      folder({ id: "a", name: "alpha" }),
      folder({ id: "a-b", name: "beta", parent_id: "a" }),
      folder({ id: "a-a", name: "aleph", parent_id: "a" }),
    ]);
    expect(nodes.map((n) => n.folder.name)).toEqual(["alpha", "zeta"]);
    expect(nodes[0]?.children.map((n) => n.folder.name)).toEqual(["aleph", "beta"]);
  });

  it("surfaces orphans at root instead of dropping them", () => {
    const nodes = buildFolderNodes([folder({ id: "x", parent_id: "gone" })]);
    expect(nodes.map((n) => n.folder.id)).toEqual(["x"]);
  });
});

describe("collectSubtreeFolderIds", () => {
  const folders = [
    folder({ id: "root" }),
    folder({ id: "child", parent_id: "root" }),
    folder({ id: "grand", parent_id: "child" }),
    folder({ id: "other" }),
  ];

  it("includes the root and all descendants", () => {
    expect([...collectSubtreeFolderIds(folders, "root")].sort()).toEqual(["child", "grand", "root"]);
  });

  it("returns an empty set for an unknown folder", () => {
    expect(collectSubtreeFolderIds(folders, "missing").size).toBe(0);
  });
});

describe("folderDisplayPath", () => {
  it("joins ancestor names", () => {
    const folders = [
      folder({ id: "root", name: "Package" }),
      folder({ id: "child", name: "deep", parent_id: "root" }),
    ];
    expect(folderDisplayPath(folders, "child")).toBe("Package / deep");
    expect(folderDisplayPath(folders, "root")).toBe("Package");
    expect(folderDisplayPath(folders, "missing")).toBe("");
  });
});

describe("move destinations", () => {
  const folders = [
    folder({ id: "custom-a", name: "A" }),
    folder({ id: "custom-b", name: "B", parent_id: "custom-a" }),
    folder({ id: "pkg-root", name: "R", package_id: "p", package_path: "" }),
    folder({ id: "managed", name: "M", package_id: "p", package_path: "deep", parent_id: "pkg-root" }),
  ];

  it("skills move into custom folders and package roots, never managed internals", () => {
    expect(skillMoveDestinations(folders).map((f) => f.id).sort()).toEqual(["custom-a", "custom-b", "pkg-root"]);
  });

  it("folders move only within the custom tree, excluding self and descendants", () => {
    expect(folderMoveDestinations(folders, "custom-a").map((f) => f.id)).toEqual([]);
    expect(folderMoveDestinations(folders, "custom-b").map((f) => f.id)).toEqual(["custom-a"]);
    expect(folderMoveDestinations(folders, "pkg-root").map((f) => f.id).sort()).toEqual(["custom-a", "custom-b"]);
    expect(folderMoveDestinations(folders, "managed")).toEqual(folderMoveDestinations(folders, "pkg-root"));
  });
});

describe("commonCandidatePrefix", () => {
  it("finds the shared parent directory", () => {
    expect(commonCandidatePrefix(["skills/a", "skills/b"])).toBe("skills");
    expect(commonCandidatePrefix(["x/deep/a", "x/deep/sub/b"])).toBe("x/deep");
    expect(commonCandidatePrefix(["skills/only"])).toBe("skills");
    expect(commonCandidatePrefix([""])).toBe("");
    expect(commonCandidatePrefix(["a", "skills/b"])).toBe("");
    expect(commonCandidatePrefix([])).toBe("");
  });
});

describe("grayCandidates", () => {
  const folders = [
    folder({ id: "root-f", name: "o/r", package_id: "p1", package_path: "" }),
    folder({ id: "deep-f", name: "deep", package_id: "p1", package_path: "deep", parent_id: "root-f" }),
  ];
  const thePkg = pkg({
    id: "p1",
    root_folder_id: "root-f",
    candidates: [
      { path: "skills/imported", name: "imported", description: "" },
      { path: "skills/loose", name: "loose", description: "gray" },
      { path: "skills/deep/nested", name: "nested", description: "" },
    ],
  });

  it("lists candidates without a placement under their managed folder", () => {
    const t = tree({
      folders,
      packages: [thePkg],
      placements: [placement({ skill_id: "s1", folder_id: "root-f", package_id: "p1", source_path: "skills/imported" })],
    });
    const gray = grayCandidates(t);
    expect(gray.map((g) => g.path).sort()).toEqual(["skills/deep/nested", "skills/loose"]);
    expect(gray.find((g) => g.path === "skills/loose")?.folderId).toBe("root-f");
    expect(gray.find((g) => g.path === "skills/deep/nested")?.folderId).toBe("deep-f");
  });

  it("falls back to the package root when the managed folder is missing", () => {
    const t = tree({
      folders: folders.filter((f) => f.id === "root-f"),
      packages: [thePkg],
      placements: [],
    });
    const nested = grayCandidates(t).find((g) => g.path === "skills/deep/nested");
    expect(nested?.folderId).toBe("root-f");
  });

  it("does not gray a candidate whose placement belongs to the package", () => {
    const t = tree({
      folders,
      packages: [thePkg],
      placements: [
        placement({ skill_id: "s1", folder_id: "root-f", package_id: "p1", source_path: "skills/imported" }),
        placement({ skill_id: "s2", folder_id: "deep-f", package_id: "p1", source_path: "skills/deep/nested" }),
        placement({ skill_id: "s3", folder_id: "root-f", package_id: "p1", source_path: "skills/loose" }),
      ],
    });
    expect(grayCandidates(t)).toEqual([]);
  });
});

describe("packageForRootFolder", () => {
  it("matches by root folder id", () => {
    const t = tree({ packages: [pkg({ id: "p1", root_folder_id: "root-f" })] });
    expect(packageForRootFolder(t, "root-f")?.id).toBe("p1");
    expect(packageForRootFolder(t, "other")).toBeNull();
  });
});

describe("skillMatchesFolderSelection", () => {
  const t = tree({
    folders: [
      folder({ id: "root" }),
      folder({ id: "child", parent_id: "root" }),
    ],
    placements: [
      placement({ skill_id: "in-root", folder_id: "root" }),
      placement({ skill_id: "in-child", folder_id: "child" }),
    ],
  });

  it("all matches everything", () => {
    expect(skillMatchesFolderSelection(t, { kind: "all" }, "anything")).toBe(true);
  });

  it("uncategorized matches only skills without a placement", () => {
    expect(skillMatchesFolderSelection(t, { kind: "uncategorized" }, "loose")).toBe(true);
    expect(skillMatchesFolderSelection(t, { kind: "uncategorized" }, "in-root")).toBe(false);
  });

  it("a folder matches its whole subtree", () => {
    expect(skillMatchesFolderSelection(t, { kind: "folder", folderId: "root" }, "in-child")).toBe(true);
    expect(skillMatchesFolderSelection(t, { kind: "folder", folderId: "child" }, "in-root")).toBe(false);
    expect(skillMatchesFolderSelection(t, { kind: "folder", folderId: "child" }, "loose")).toBe(false);
  });
});
