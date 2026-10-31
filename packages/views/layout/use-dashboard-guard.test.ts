// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dashboardLoginPath } from "./use-dashboard-guard";

describe("dashboardLoginPath", () => {
  it("preserves the workspace path, candidate query, and fragment", () => {
    expect(dashboardLoginPath({
      pathname: "/acme/projects/project-1/engineering",
      searchParams: new URLSearchParams({ candidate: "rev-1" }),
      hash: "#approval",
    })).toBe(`/login?next=${encodeURIComponent("/acme/projects/project-1/engineering?candidate=rev-1#approval")}`);
  });
});
