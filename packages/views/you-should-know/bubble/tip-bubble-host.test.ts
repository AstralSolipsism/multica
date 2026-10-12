// @vitest-environment node
import { describe, expect, it } from "vitest";
import { acknowledgeVisibility } from "./tip-bubble-host";

describe("acknowledgeVisibility", () => {
  it("lets a visible bubble claim the screen for its tip", () => {
    expect(acknowledgeVisibility(null, "a", true)).toBe("a");
    // A replacement bubble takes over from whatever held it.
    expect(acknowledgeVisibility("a", "b", true)).toBe("b");
  });

  it("releases the screen only for the tip that holds it", () => {
    expect(acknowledgeVisibility("a", "a", false)).toBeNull();
    // A late "not visible" from the bubble that already left must not clear
    // the receipt of the bubble that replaced it.
    expect(acknowledgeVisibility("b", "a", false)).toBe("b");
    expect(acknowledgeVisibility(null, "a", false)).toBeNull();
  });
});
