// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dagProjectColor, DAG_PROJECT_NEUTRAL } from "./dag-project-colors";

describe("dagProjectColor", () => {
  it("assigns the same project the same color every time", () => {
    expect(dagProjectColor("proj-1")).toBe(dagProjectColor("proj-1"));
    expect(dagProjectColor("proj-1")).not.toBe(dagProjectColor("proj-2"));
  });

  it("uses the neutral color for project-less cards", () => {
    expect(dagProjectColor(null)).toBe(DAG_PROJECT_NEUTRAL.light);
    expect(dagProjectColor(undefined)).toBe(DAG_PROJECT_NEUTRAL.light);
    expect(dagProjectColor("")).toBe(DAG_PROJECT_NEUTRAL.light);
  });

  it("assigns colors from the palette, with a dark variant for dark mode", () => {
    const light = new Set(["#4f8ef7", "#8b5cf6", "#d946ef", "#ec4899", "#f4735c", "#f59e0b", "#84cc16", "#10b981", "#14b8a6", "#06b6d4"]);
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      expect(light.has(dagProjectColor(id))).toBe(true);
      expect(dagProjectColor(id, true)).not.toBe(dagProjectColor(id));
    }
    expect(dagProjectColor(null, true)).toBe(DAG_PROJECT_NEUTRAL.dark);
  });
});
