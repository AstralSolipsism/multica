import { z } from "zod";

export const SkillImportDiagnosticSchema = z.object({
  code: z.string().min(1),
  path: z.string().optional(),
  target: z.string().optional(),
  message: z.string(),
  retryable: z.boolean().catch(false),
});

const diagnostics = z.array(SkillImportDiagnosticSchema);
const id = z.string().min(1);
const candidateSummary = z.object({
  path: z.string(), // An empty path identifies a repository-root SKILL.md.
  name: z.string(),
  description: z.string().default(""),
  digest: z.string().optional(),
});

export const SkillFolderSchema = z.object({
  id,
  workspace_id: id,
  parent_id: id.nullable(),
  name: z.string().min(1),
  package_id: id.nullable(),
  package_path: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const SkillPlacementSchema = z.object({
  workspace_id: id,
  skill_id: id,
  folder_id: id,
  package_id: id.nullable(),
  source_path: z.string().nullable(),
});

export const SkillPackageSchema = z.object({
  id,
  workspace_id: id,
  owner_repo: z.string().min(1),
  subdirectory: z.string(),
  source_url: z.string().min(1),
  ref: z.string().min(1),
  root_folder_id: id,
  created_by: id,
  revision: z.number().int().positive(),
  candidates: z.array(candidateSummary),
});

export const SkillFolderTreeSchema = z.object({
  folders: z.array(SkillFolderSchema),
  placements: z.array(SkillPlacementSchema),
  packages: z.array(SkillPackageSchema),
});

export const SkillPackageListSchema = z.object({ packages: z.array(SkillPackageSchema) });

export const SkillPackageCandidateSchema = candidateSummary.extend({
  state: z.enum(["new", "adoptable", "changed", "unchanged", "removed", "conflict", "failed", "unknown"]).catch("unknown"),
  default_selected: z.boolean().catch(false),
  can_write: z.boolean().catch(false),
  skill_id: id.optional(),
  conflict: z.string().optional(),
  file_count: z.number().int().nonnegative().default(0),
  bytes: z.number().int().nonnegative().default(0),
  shared_files: z.array(z.string()),
  diagnostics,
}).transform((candidate) => candidate.state === "unknown"
  ? { ...candidate, can_write: false, default_selected: false }
  : candidate);

export const SkillPackagePreviewSchema = z.object({
  preview_id: id,
  source: z.object({
    url: z.string().min(1), owner_repo: z.string().min(1), subdirectory: z.string(),
    ref: z.string().min(1), revision: z.string().min(1),
  }),
  package: SkillPackageSchema.optional(),
  candidates: z.array(SkillPackageCandidateSchema),
  diagnostics,
});

export const SkillPackageItemResultSchema = z.object({
  path: z.string(),
  status: z.enum(["created", "adopted", "updated", "unchanged", "skipped", "retained", "failed", "unknown"]).catch("unknown"),
  skill_id: id.optional(),
  code: z.string().optional(),
  reason: z.string().optional(),
  retryable: z.boolean().catch(false),
  diagnostics,
});

// A malformed or newer write result must not turn into an empty success.
// Use parseWithFallback(..., null, ...) and keep null visibly indeterminate.
export const SkillPackageApplySchema = z.object({
  package: SkillPackageSchema.optional(),
  results: z.array(SkillPackageItemResultSchema),
  failed: z.boolean(),
  diagnostics,
}).transform((result) => ({
  ...result,
  failed: result.failed || result.results.some((item) => item.status === "failed" || item.status === "unknown"),
}));

export const SkillPackageDeletePreviewSchema = z.object({
  preview_id: id,
  skill_ids: z.array(id),
  affected_agents: z.array(z.object({ id, name: z.string(), skill_id: id, skill_name: z.string() })),
  can_delete: z.boolean().catch(false),
});

export const SkillPlacementUpdatedSchema = z.object({ updated: z.literal(true) });
export const SkillFolderDeletedSchema = z.object({ deleted: z.literal(true) });
export const SkillPackageRemovedSchema = z.object({
  deleted: z.boolean(), dissolved: z.boolean(), skill_count: z.number().int().nonnegative(),
}).refine((value) => value.deleted !== value.dissolved);

export type SkillFolder = z.infer<typeof SkillFolderSchema>;
export type SkillPlacement = z.infer<typeof SkillPlacementSchema>;
export type SkillPackage = z.infer<typeof SkillPackageSchema>;
export type SkillFolderTree = z.infer<typeof SkillFolderTreeSchema>;
export type SkillPackagePreview = z.infer<typeof SkillPackagePreviewSchema>;
export type SkillPackageApplyResult = z.infer<typeof SkillPackageApplySchema>;
export type SkillPackageDeletePreview = z.infer<typeof SkillPackageDeletePreviewSchema>;

export type SkillPackageRequest = {
  url?: string;
  preview_id?: string;
  skills?: string[];
  all?: boolean;
  on_conflict?: "skip" | "rename" | "overwrite";
  apply?: boolean;
};
