import { z } from "zod";
import { parseWithFallback } from "./schema";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.uuid();

// Unknown statuses remain readable, but callers may acknowledge a save only
// when status === "SAVED". Malformed responses always produce null.
export const ProjectFileResultSchema = z.object({
  operation_id: z.string().min(1),
  status: z.string().min(1),
  file_id: id,
  path: z.string().min(1),
  base_revision: revision,
  revision,
  version_id: id,
  candidate_id: id.optional(),
  conflict_current: revision.optional(),
  replayed: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.status === "SAVED" && (value.candidate_id !== undefined || value.revision < 1)) {
    ctx.addIssue({ code: "custom", message: "Invalid SAVED result" });
  }
  if (value.status === "CONFLICT" && (!value.candidate_id || value.conflict_current !== value.revision)) {
    ctx.addIssue({ code: "custom", message: "Incomplete CONFLICT result" });
  }
}).transform((value) => ({
  operationId: value.operation_id,
  status: value.status,
  fileId: value.file_id,
  path: value.path,
  baseRevision: value.base_revision,
  revision: value.revision,
  versionId: value.version_id,
  candidateId: value.candidate_id,
  conflictCurrent: value.conflict_current,
  replayed: value.replayed,
}));

export const ProjectFileSchema = z.object({
  file_id: id,
  path: z.string().min(1),
  revision,
  base_revision: revision,
  version_id: id,
  candidate_id: id.optional(),
  size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content_type: z.string(),
  author_type: z.string(),
  author_id: id,
  source_task_id: id.optional(),
  updated_at: z.string(),
}).transform((value) => ({
  fileId: value.file_id,
  path: value.path,
  revision: value.revision,
  baseRevision: value.base_revision,
  versionId: value.version_id,
  candidateId: value.candidate_id,
  sizeBytes: value.size_bytes,
  sha256: value.sha256,
  contentType: value.content_type,
  authorType: value.author_type,
  authorId: value.author_id,
  sourceTaskId: value.source_task_id,
  updatedAt: value.updated_at,
}));

export const ProjectFilePageSchema = z.object({
  files: z.array(ProjectFileSchema).max(200),
  next_cursor: z.string().optional(),
}).transform((value) => ({ files: value.files, nextCursor: value.next_cursor }));

export const ProjectFileOperationSchema = z.object({
  state: z.string(),
  operation_id: z.string().min(1),
  result: ProjectFileResultSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.state === "COMPLETED" && !value.result)
    || (value.state === "PENDING" && value.result)
    || (value.result && value.operation_id !== value.result.operationId)) {
    ctx.addIssue({ code: "custom", message: "Inconsistent operation state" });
  }
}).transform((value) => ({ state: value.state, operationId: value.operation_id, result: value.result }));

export const ProjectFileCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  api_version: z.number().int().positive(),
  read_only: z.boolean(),
  max_file_bytes: z.number().int().positive(),
  max_page_size: z.number().int().positive().max(200),
}).transform((value) => ({
  enabled: value.enabled,
  apiVersion: value.api_version,
  readOnly: value.read_only,
  maxFileBytes: value.max_file_bytes,
  maxPageSize: value.max_page_size,
}));

export type ProjectFileResult = z.output<typeof ProjectFileResultSchema>;

export function parseProjectFileResult(data: unknown): ProjectFileResult | null {
  return parseWithFallback<ProjectFileResult | null>(data, ProjectFileResultSchema, null, {
    endpoint: "project files: save/adopt",
  });
}
