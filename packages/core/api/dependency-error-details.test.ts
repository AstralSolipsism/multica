// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ApiError, dependencyErrorDetails } from "./client";

const refusal = (body: unknown) => new ApiError("conflict", 409, "Conflict", body);

describe("dependencyErrorDetails", () => {
  it.each([
    null, undefined, "error", new Error("dependency_ancestor_conflict"),
    { body: { reason_code: "dependency_ancestor_conflict" } },
    refusal(null), refusal("dependency_ancestor_conflict"), refusal({}),
    refusal({ reason_code: 42 }), refusal({ reason_code: "" }),
    refusal({ code: "dependency_ancestor_conflict" }),
    refusal({ reason_code: "dispatch_blocked" }),
  ])("does not reinterpret a non-dependency error: %j", (error) => {
    expect(dependencyErrorDetails(error)).toBeNull();
  });

  it.each(["dependency_ancestor_conflict", "dependency_cycle", "dependency_version_conflict", "dependency_future_reason"])(
    "keeps the reason for %s", (reasonCode) => {
      expect(dependencyErrorDetails(refusal({ reason_code: reasonCode }))).toEqual({ reasonCode });
    },
  );
});
