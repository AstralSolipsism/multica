// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import { SkillSchema } from "./schemas";
import {
  SkillFolderTreeSchema, SkillPackageApplySchema, SkillPackageCandidateSchema,
  SkillPackageDeletePreviewSchema, SkillPackagePreviewSchema, SkillPackageRemovedSchema,
} from "./labrastro-skill-schemas";

const parse = (data: unknown, schema: Parameters<typeof parseWithFallback>[1]) =>
  parseWithFallback(data, schema, null, { endpoint: "skill package test" });
const item = { path: "skills/a", status: "created", skill_id: "a", retryable: false, diagnostics: [] };
const candidate = {
  path: "skills/a", name: "a", description: "", state: "new", default_selected: true,
  can_write: true, shared_files: [], diagnostics: [],
};

describe("skill package response boundary", () => {
  it.each([{}, null, { results: [] }, { results: "bad", failed: false },
    { results: [{ ...item, path: undefined }], failed: false, diagnostics: [] },
  ])("does not invent write success from incomplete results: %j", (body) => {
    expect(parse(body, SkillPackageApplySchema)).toBeNull();
  });

  it("keeps unknown and partial outcomes visible as failures", () => {
    const result = SkillPackageApplySchema.parse({ results: [item, { ...item, status: "future", reason: "server detail" }], failed: false, diagnostics: [] });
    expect(result.failed).toBe(true);
    expect(result.results[1]).toMatchObject({ status: "unknown", reason: "server detail" });
  });

  it("does not make an unknown candidate selectable", () => {
    expect(SkillPackageCandidateSchema.parse({ ...candidate, state: "future" }))
      .toMatchObject({ state: "unknown", default_selected: false, can_write: false });
    expect(SkillPackageCandidateSchema.parse({ ...candidate, can_write: undefined, default_selected: undefined }))
      .toMatchObject({ default_selected: false, can_write: false });
  });

  it("accepts a repository-root candidate but requires a preview token", () => {
    const preview = { preview_id: "signed-token", source: { url: "https://github.com/o/r/tree/main", owner_repo: "o/r", ref: "main", revision: "sha", subdirectory: "" }, candidates: [{ ...candidate, path: "" }], diagnostics: [] };
    expect(parse(preview, SkillPackagePreviewSchema)).not.toBeNull();
    expect(parse({ ...preview, preview_id: undefined }, SkillPackagePreviewSchema)).toBeNull();
  });

  it("requires complete tree and deletion decision data", () => {
    expect(parse({}, SkillFolderTreeSchema)).toBeNull();
    expect(parse({ folders: [], placements: [], packages: [] }, SkillFolderTreeSchema)).not.toBeNull();
    expect(SkillPackageDeletePreviewSchema.parse({ preview_id: "signed", skill_ids: [], affected_agents: [] }).can_delete).toBe(false);
    expect(parse({ preview_id: "signed", can_delete: true }, SkillPackageDeletePreviewSchema)).toBeNull();
    expect(parse({ deleted: false, dissolved: false, skill_count: 0 }, SkillPackageRemovedSchema)).toBeNull();
  });

  it("preserves old skill payloads and reports malformed additive diagnostics as unknown", () => {
    const skill = { id: "a", workspace_id: "ws", name: "a", content: "body", files: [] };
    expect(SkillSchema.parse(skill)).toMatchObject({ content: "body" });
    expect(SkillSchema.parse({ ...skill, diagnostics: "bad" })).toMatchObject({ content: "body", diagnostics: null });
    expect(SkillSchema.parse({ ...skill, diagnostics: [{ code: "new_code", message: "detail", retryable: true }] }).diagnostics?.[0]?.code).toBe("new_code");
  });
});
