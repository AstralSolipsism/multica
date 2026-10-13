// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@multica/core/types";
import { commentTimeLookup } from "./comment-time-lookup";

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: "comment",
    id: "c-1",
    actor_type: "member",
    actor_id: "user-1",
    created_at: "2026-10-13T08:20:00Z",
    ...overrides,
  };
}

describe("commentTimeLookup", () => {
  it("returns each comment's creation time by id", () => {
    const lookup = commentTimeLookup([
      entry({ id: "c-1", created_at: "2026-10-13T08:20:00Z" }),
      entry({ id: "c-2", created_at: "2026-10-13T09:05:00Z" }),
    ]);
    expect(lookup("c-1")).toBe("2026-10-13T08:20:00Z");
    expect(lookup("c-2")).toBe("2026-10-13T09:05:00Z");
  });

  it("reads created_at, not updated_at, so labels match the comment card after edits", () => {
    const lookup = commentTimeLookup([
      entry({
        id: "c-1",
        created_at: "2026-10-13T08:20:00Z",
        updated_at: "2026-10-13T10:00:00Z",
      }),
    ]);
    expect(lookup("c-1")).toBe("2026-10-13T08:20:00Z");
  });

  it("skips activities and misses unknown ids", () => {
    const lookup = commentTimeLookup([
      entry({ type: "activity", id: "a-1", created_at: "2026-10-13T08:20:00Z" }),
    ]);
    expect(lookup("a-1")).toBeUndefined();
    expect(lookup("missing")).toBeUndefined();
  });
});
