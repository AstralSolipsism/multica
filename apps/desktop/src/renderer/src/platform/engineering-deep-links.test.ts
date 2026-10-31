// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingEngineeringDestination,
  consumeEngineeringDestinationForReauth,
  isEngineeringCandidatePath,
  preserveEngineeringDestinationForReauth,
} from "./engineering-deep-links";

const candidatePath = "/acme/projects/p1/engineering?candidate=rev-1";

beforeEach(() => {
  clearPendingEngineeringDestination();
});

describe("isEngineeringCandidatePath", () => {
  it("matches only project engineering URLs with a candidate", () => {
    expect(isEngineeringCandidatePath(candidatePath)).toBe(true);
    expect(isEngineeringCandidatePath(`${candidatePath}#diff`)).toBe(true);
    expect(isEngineeringCandidatePath("/acme/projects/p1/engineering")).toBe(false);
    expect(isEngineeringCandidatePath("/acme/projects/p1/engineering?candidate=")).toBe(false);
    expect(isEngineeringCandidatePath("/acme/projects/p1?candidate=rev-1")).toBe(false);
    expect(isEngineeringCandidatePath("/acme/issues?candidate=rev-1")).toBe(false);
  });
});

describe("engineering re-auth destination", () => {
  it("restores once for the same account", () => {
    preserveEngineeringDestinationForReauth("user-1", candidatePath);

    expect(consumeEngineeringDestinationForReauth("user-1")).toBe(candidatePath);
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();
  });

  it("does not restore into a different account", () => {
    preserveEngineeringDestinationForReauth("user-1", candidatePath);

    expect(consumeEngineeringDestinationForReauth("user-2")).toBeNull();
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();
  });

  it("clears on explicit logout and rejects non-candidate paths", () => {
    preserveEngineeringDestinationForReauth("user-1", candidatePath);
    clearPendingEngineeringDestination();
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();

    preserveEngineeringDestinationForReauth("user-1", "/acme/issues");
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();
  });
});
