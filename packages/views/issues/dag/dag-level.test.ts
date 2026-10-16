// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DAG_INDEPENDENT_GROUP } from "@multica/core/issues/dag";
import {
  DAG_OVERVIEW_LEVEL,
  dagAutoEnterLineId,
  dagContainingLineId,
  dagExternalJumpTarget,
  dagLevelFromLineId,
  dagLevelIsIndependent,
  dagLevelViewportKey,
  dagOverviewCardIdForLine,
} from "./dag-level";

describe("dagLevelFromLineId / dagLevelViewportKey", () => {
  it("maps the persisted line id onto the two levels", () => {
    expect(dagLevelFromLineId(null)).toEqual(DAG_OVERVIEW_LEVEL);
    expect(dagLevelFromLineId("root-1")).toEqual({ kind: "line", lineId: "root-1" });
    expect(dagLevelViewportKey(DAG_OVERVIEW_LEVEL)).toBe("overview");
    expect(dagLevelViewportKey({ kind: "line", lineId: "root-1" })).toBe("line:root-1");
  });

  it("treats the independent grid as a line level", () => {
    const level = dagLevelFromLineId(DAG_INDEPENDENT_GROUP);
    expect(dagLevelIsIndependent(level)).toBe(true);
    expect(dagLevelIsIndependent({ kind: "line", lineId: "root-1" })).toBe(false);
    expect(dagLevelIsIndependent(DAG_OVERVIEW_LEVEL)).toBe(false);
  });
});

describe("dagOverviewCardIdForLine", () => {
  it("maps a line back to its overview card", () => {
    expect(dagOverviewCardIdForLine("root-1")).toBe("issue:root-1");
    expect(dagOverviewCardIdForLine(DAG_INDEPENDENT_GROUP)).toBe(DAG_INDEPENDENT_GROUP);
  });
});

describe("dagAutoEnterLineId", () => {
  it("enters the only visible line until the user pins the overview", () => {
    expect(dagAutoEnterLineId({ pinned: false, autoEnterLineId: "root-1" })).toBe("root-1");
    expect(dagAutoEnterLineId({ pinned: true, autoEnterLineId: "root-1" })).toBeNull();
    expect(dagAutoEnterLineId({ pinned: false, autoEnterLineId: null })).toBeNull();
  });
});

describe("dagExternalJumpTarget", () => {
  it("enters lines and locates standalone tasks on the overview", () => {
    expect(dagExternalJumpTarget({ id: "root-2", kind: "line" })).toEqual({
      kind: "line",
      lineId: "root-2",
    });
    expect(dagExternalJumpTarget({ id: "solo-1", kind: "issue" })).toEqual({
      kind: "overview",
      cardId: "solo-1",
    });
  });
});


describe("dagContainingLineId", () => {
  const issues = new Map([
    ["root", { parentIssueId: null }],
    ["sub", { parentIssueId: "root" }],
    ["task", { parentIssueId: "sub" }],
    ["solo", { parentIssueId: null }],
    ["orphan", { parentIssueId: "restricted" }],
    ["orphan-child", { parentIssueId: "orphan" }],
    ["cycle-a", { parentIssueId: "cycle-b" }],
    ["cycle-b", { parentIssueId: "cycle-a" }],
  ]);
  it("finds the visible root for a nested task or frame", () => {
    expect(dagContainingLineId("task", issues)).toBe("root");
    expect(dagContainingLineId("root", issues)).toBe("root");
    expect(dagContainingLineId("orphan-child", issues)).toBe("orphan");
  });
  it("has no line for a standalone, missing or cyclic task", () => {
    expect(dagContainingLineId("solo", issues)).toBeNull();
    expect(dagContainingLineId("missing", issues)).toBeNull();
    expect(dagContainingLineId("cycle-a", issues)).toBeNull();
  });
});
