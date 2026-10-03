// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  SkillPackageCandidate,
  SkillPackageItemResult,
} from "@multica/core/api/schemas";
import {
  applyRequestBase,
  canApplyOverwrite,
  defaultSelectedPaths,
  hasSelectedConflict,
  isCandidateSelectable,
  isItemFailure,
  sameNameGroups,
} from "./package-preview-model";

function candidate(partial: Partial<SkillPackageCandidate> & { path: string }): SkillPackageCandidate {
  return {
    name: partial.path,
    description: "",
    state: "new",
    default_selected: false,
    can_write: true,
    file_count: 0,
    bytes: 0,
    shared_files: [],
    diagnostics: [],
    ...partial,
  };
}

describe("isCandidateSelectable", () => {
  it("allows live states and rejects removed/failed/unknown", () => {
    for (const state of ["new", "adoptable", "changed", "unchanged", "conflict"] as const) {
      expect(isCandidateSelectable(candidate({ path: "x", state }))).toBe(true);
    }
    for (const state of ["removed", "failed", "unknown"] as const) {
      expect(isCandidateSelectable(candidate({ path: "x", state }))).toBe(false);
    }
  });
});

describe("defaultSelectedPaths", () => {
  it("checks exactly the server's defaults within the selectable set", () => {
    const candidates = [
      candidate({ path: "a", default_selected: true }),
      candidate({ path: "b", default_selected: false }),
      candidate({ path: "c", state: "conflict", default_selected: true, can_write: false }),
      // already_packaged conflicts are not default-selected by the server;
      // even a malformed default stays out when the state is unselectable.
      candidate({ path: "d", state: "removed", default_selected: true }),
      candidate({ path: "e", state: "unknown", default_selected: true }),
    ];
    expect([...defaultSelectedPaths(candidates)].sort()).toEqual(["a", "c"]);
  });
});

describe("canApplyOverwrite", () => {
  const candidates = [
    candidate({ path: "owned", state: "conflict", can_write: true }),
    candidate({ path: "foreign", state: "conflict", can_write: false }),
    candidate({ path: "fresh", state: "new", can_write: false }),
  ];

  it("requires can_write on every selected conflict, and only conflicts", () => {
    expect(canApplyOverwrite(candidates, new Set(["owned"]))).toBe(true);
    expect(canApplyOverwrite(candidates, new Set(["owned", "foreign"]))).toBe(false);
    // can_write never gates non-conflict rows (rename creates a copy freely).
    expect(canApplyOverwrite(candidates, new Set(["fresh"]))).toBe(true);
    expect(canApplyOverwrite(candidates, new Set())).toBe(true);
  });
});

describe("hasSelectedConflict", () => {
  it("detects conflicts inside the selection only", () => {
    const candidates = [candidate({ path: "c", state: "conflict" })];
    expect(hasSelectedConflict(candidates, new Set(["c"]))).toBe(true);
    expect(hasSelectedConflict(candidates, new Set())).toBe(false);
  });
});

describe("sameNameGroups", () => {
  it("flags names shared by several selected candidates", () => {
    const candidates = [
      candidate({ path: "a/dup", name: "dup" }),
      candidate({ path: "b/dup", name: "dup" }),
      candidate({ path: "c/dup", name: "dup" }),
      candidate({ path: "solo", name: "solo" }),
    ];
    expect(sameNameGroups(candidates, new Set(["a/dup", "b/dup", "solo"]))).toEqual(["dup"]);
    // Deselected duplicates do not warn.
    expect(sameNameGroups(candidates, new Set(["a/dup", "solo"]))).toEqual([]);
  });
});

describe("isItemFailure", () => {
  const item = (status: SkillPackageItemResult["status"]): SkillPackageItemResult => ({
    path: "x",
    status,
    retryable: false,
    diagnostics: [],
  });

  it("treats failed and unknown as failures only", () => {
    expect(isItemFailure(item("failed"))).toBe(true);
    expect(isItemFailure(item("unknown"))).toBe(true);
    for (const status of ["created", "adopted", "updated", "unchanged", "skipped", "retained"] as const) {
      expect(isItemFailure(item(status))).toBe(false);
    }
  });
});

describe("applyRequestBase", () => {
  it("echoes the preview source URL and token", () => {
    const base = applyRequestBase({
      preview_id: "tok",
      source: { url: "https://github.com/o/r/tree/main", owner_repo: "o/r", subdirectory: "", ref: "main", revision: "abc" },
      candidates: [],
      diagnostics: [],
    });
    expect(base).toEqual({ url: "https://github.com/o/r/tree/main", preview_id: "tok" });
  });
});
