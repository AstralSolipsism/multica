// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseProjectFileResult,
  ProjectFileCapabilitiesSchema,
  ProjectFileOperationSchema,
  ProjectFilePageSchema,
} from "./project-file-schemas";

const id = "00000000-0000-4000-8000-000000000001";
const saved = {
  operation_id: "save-1", status: "SAVED", file_id: id, path: "facts.md",
  base_revision: 0, revision: 1, version_id: id, replayed: false,
};

describe("project file response boundary", () => {
  it("preserves complete results and exposes camelCase fields", () => {
    expect(parseProjectFileResult(saved)).toMatchObject({ operationId: "save-1", baseRevision: 0, status: "SAVED", replayed: false });
    expect(parseProjectFileResult({ ...saved, replayed: true })).toEqual({ ...parseProjectFileResult(saved), replayed: true });
  });

  it.each([null, {}, { ...saved, revision: "1" }, { ...saved, file_id: "bad" },
    { ...saved, candidate_id: id }, { ...saved, replayed: undefined },
    { ...saved, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...saved, status: "CONFLICT" }, { ...saved, status: "CONFLICT", candidate_id: id, conflict_current: 2 },
  ])("never acknowledges a malformed response: %j", (response) => {
    expect(parseProjectFileResult(response)).toBeNull();
  });

  it("accepts complete conflicts and unknown future statuses without inventing success", () => {
    expect(parseProjectFileResult({ ...saved, status: "CONFLICT", candidate_id: id, conflict_current: 1 })?.candidateId).toBe(id);
    expect(parseProjectFileResult({ ...saved, status: "FUTURE_STATUS" })?.status).toBe("FUTURE_STATUS");
  });

  it("rejects inconsistent operation envelopes", () => {
    expect(ProjectFileOperationSchema.safeParse({ state: "COMPLETED", operation_id: "save-1" }).success).toBe(false);
    expect(ProjectFileOperationSchema.safeParse({ state: "PENDING", operation_id: "save-1", result: saved }).success).toBe(false);
    expect(ProjectFileOperationSchema.safeParse({ state: "COMPLETED", operation_id: "other", result: saved }).success).toBe(false);
    expect(ProjectFileOperationSchema.safeParse({ state: "COMPLETED", operation_id: "save-1", result: saved }).success).toBe(true);
  });

  it("requires bounded lists and valid capability limits", () => {
    expect(ProjectFilePageSchema.parse({ files: [] })).toEqual({ files: [] });
    expect(ProjectFilePageSchema.safeParse({ files: [null] }).success).toBe(false);
    expect(ProjectFileCapabilitiesSchema.safeParse({ enabled: true, api_version: 1, read_only: false, max_file_bytes: -1, max_page_size: 200 }).success).toBe(false);
  });
});
