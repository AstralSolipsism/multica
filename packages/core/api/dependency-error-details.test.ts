// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ApiError, dependencyErrorDetails } from "./client";

const prerequisite = {
  issue_id: "issue-1", status: "todo", status_category: "unstarted", satisfied: false,
  source_edges: ["edge-1"], inherited_from: ["parent-1"], identifier: "OL-1",
};
const projection = {
  blocked_by: [prerequisite], inherited_blocked_by: [], blocking: [],
  unsatisfied: [prerequisite], has_restricted_blockers: false, dependency_version: "v2",
};
const refusal = (body: unknown) => new ApiError("conflict", 409, "Conflict", body);

describe("dependencyErrorDetails", () => {
  it.each([
    null, undefined, "error", new Error("dependency_unsatisfied"),
    { body: { reason_code: "dependency_unsatisfied" } },
    refusal(null), refusal("dependency_unsatisfied"), refusal({}),
    refusal({ reason_code: 42 }), refusal({ reason_code: "" }),
    refusal({ code: "dependency_unsatisfied" }),
    refusal({ reason_code: "dispatch_blocked", dependencies: projection }),
  ])("does not reinterpret a non-dependency error: %j", (error) => {
    expect(dependencyErrorDetails(error)).toBeNull();
  });

  it.each(["dependency_unsatisfied", "dependency_cycle", "dependency_version_conflict", "dependency_future_reason"])(
    "keeps the reason and parses the wire projection for %s", (reasonCode) => {
      const result = dependencyErrorDetails(refusal({ reason_code: reasonCode, dependencies: projection }));
      expect(result).toEqual({
        reasonCode,
        dependencies: {
          blockedBy: [expect.objectContaining({ issueId: "issue-1", statusCategory: "unstarted", inheritedFrom: ["parent-1"], sourceEdges: ["edge-1"] })],
          inheritedBlockedBy: [], blocking: [],
          unsatisfied: [expect.objectContaining({ issueId: "issue-1", satisfied: false })],
          hasRestrictedBlockers: false, dependencyVersion: "v2",
        },
      });
    },
  );

  it.each([
    undefined, null, {}, "broken",
    { ...projection, blocked_by: [{}] },
    { ...projection, dependency_version: "" },
    { ...projection, blocked_by: [{ ...prerequisite, satisfied: true }] },
    { blockedBy: [], inheritedBlockedBy: [], blocking: [], unsatisfied: [], hasRestrictedBlockers: false, dependencyVersion: "v2" },
  ])("preserves the refusal but keeps unreadable dependencies unknown: %j", (dependencies) => {
    expect(dependencyErrorDetails(refusal({ reason_code: "dependency_unsatisfied", dependencies })))
      .toEqual({ reasonCode: "dependency_unsatisfied", dependencies: null });
  });
});
