// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import {
  buildPickerModel,
  defaultCollapsedFolderIds,
  PICKER_UNCATEGORIZED_ID,
  searchPickerModel,
} from "./picker-tree-model";

function skill(id: string, name = id): SkillSummary {
  return {
    id,
    workspace_id: "ws-1",
    name,
    description: "",
    config: {},
    created_by: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const tree: SkillFolderTree = {
  folders: [
    {
      id: "root",
      workspace_id: "ws-1",
      parent_id: null,
      name: "o/r",
      package_id: "p1",
      package_path: "",
      created_at: "",
      updated_at: "",
    },
    {
      id: "sub",
      workspace_id: "ws-1",
      parent_id: "root",
      name: "deep",
      package_id: "p1",
      package_path: "deep",
      created_at: "",
      updated_at: "",
    },
    {
      id: "custom",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Custom",
      package_id: null,
      package_path: null,
      created_at: "",
      updated_at: "",
    },
    {
      id: "empty-custom",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Empty",
      package_id: null,
      package_path: null,
      created_at: "",
      updated_at: "",
    },
  ],
  placements: [
    { workspace_id: "ws-1", skill_id: "s1", folder_id: "root", package_id: "p1", source_path: "skills/s1" },
    { workspace_id: "ws-1", skill_id: "s2", folder_id: "sub", package_id: "p1", source_path: "skills/deep/s2" },
    { workspace_id: "ws-1", skill_id: "s3", folder_id: "custom", package_id: null, source_path: null },
  ],
  packages: [
    {
      id: "p1",
      workspace_id: "ws-1",
      owner_repo: "o/r",
      subdirectory: "",
      source_url: "https://github.com/o/r/tree/main",
      ref: "main",
      root_folder_id: "root",
      created_by: "u1",
      revision: 1,
      candidates: [
        { path: "skills/s1", name: "s1", description: "" },
        { path: "skills/deep/s2", name: "s2", description: "" },
        { path: "skills/deep/gray", name: "gray-one", description: "" },
      ],
    },
  ],
};

const allSkills = [skill("s1"), skill("s2"), skill("s3"), skill("loose")];

describe("buildPickerModel", () => {
  it("nests caller skills under their folders and prunes empty folders", () => {
    const model = buildPickerModel(tree, allSkills, new Set());
    const folders = model.rows.filter((r) => r.kind === "folder");
    // "Empty" has no visible skills and no gray rows: pruned.
    expect(folders.map((r) => r.kind === "folder" && r.folderId)).not.toContain("empty-custom");
    const skillsUnderRoot = model.rows
      .filter((r) => r.kind === "skill")
      .map((r) => r.kind === "skill" && r.skill.id);
    expect(skillsUnderRoot).toContain("s1");
    expect(skillsUnderRoot).toContain("s2");
    expect(skillsUnderRoot).toContain("s3");
    // Gray candidate appears under "sub".
    const grayRows = model.rows.filter((r) => r.kind === "gray");
    expect(grayRows).toHaveLength(1);
    expect(grayRows[0]?.kind === "gray" && grayRows[0].candidate.name).toBe("gray-one");
    // Uncategorized skills group under the synthetic node.
    const loose = model.rows.find((r) => r.kind === "skill" && r.skill.id === "loose");
    expect(loose?.kind === "skill" && loose.depth).toBe(1);
  });

  it("prunes skills the caller filtered out, with their empty folders", () => {
    // Caller offers only s1 (e.g. everything else is already attached).
    const model = buildPickerModel(tree, [skill("s1")], new Set());
    const folderIds = model.rows.map((r) => r.kind === "folder" && r.folderId);
    expect(folderIds).not.toContain("custom");
    expect(folderIds).not.toContain(PICKER_UNCATEGORIZED_ID);
    // "sub" survives: it holds the gray candidate.
    expect(folderIds).toContain("sub");
    const skillIds = model.rows.map((r) => r.kind === "skill" && r.skill.id).filter(Boolean);
    expect(skillIds).toEqual(["s1"]);
  });

  it("hides subtree rows for collapsed folders but keeps the folder row", () => {
    const model = buildPickerModel(tree, allSkills, new Set(["root"]));
    const rows = model.rows;
    expect(rows.some((r) => r.kind === "folder" && r.folderId === "root")).toBe(true);
    expect(rows.some((r) => r.kind === "skill" && r.skill.id === "s1")).toBe(false);
    expect(rows.some((r) => r.kind === "folder" && r.folderId === "sub")).toBe(false);
    // Tri-state source still covers the collapsed subtree.
    expect(model.subtreeSkills.get("root")?.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("maps every folder row to its subtree's selectable skills (tri-state)", () => {
    const model = buildPickerModel(tree, allSkills, new Set());
    expect(model.subtreeSkills.get("root")?.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(model.subtreeSkills.get("sub")?.map((s) => s.id)).toEqual(["s2"]);
    expect(model.subtreeSkills.get("custom")?.map((s) => s.id)).toEqual(["s3"]);
    expect(model.subtreeSkills.get(PICKER_UNCATEGORIZED_ID)?.map((s) => s.id)).toEqual(["loose"]);
  });
});

describe("defaultCollapsedFolderIds", () => {
  it("collapses only folders without selectable skills (gray-only)", () => {
    const collapsed = defaultCollapsedFolderIds(tree, [skill("s1")]);
    expect(collapsed.has("sub")).toBe(true);
    expect(collapsed.has("root")).toBe(false);
  });
});

describe("searchPickerModel", () => {
  it("flattens matches with their folder paths", () => {
    const result = searchPickerModel(tree, allSkills, "s2", "Uncategorized");
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.path).toBe("o/r / deep");
  });

  it("labels uncategorized matches and matches gray candidates by name", () => {
    const loose = searchPickerModel(tree, allSkills, "loose", "Uncategorized");
    expect(loose.skills[0]?.path).toBe("Uncategorized");
    const gray = searchPickerModel(tree, allSkills, "gray", "Uncategorized");
    expect(gray.skills).toHaveLength(0);
    expect(gray.gray).toHaveLength(1);
    expect(gray.gray[0]?.path).toBe("o/r / deep");
  });

  it("returns nothing for an empty query", () => {
    expect(searchPickerModel(tree, allSkills, "  ", "x")).toEqual({ skills: [], gray: [] });
  });
});
