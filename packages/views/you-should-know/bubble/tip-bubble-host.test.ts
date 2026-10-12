// @vitest-environment node
import { describe, expect, it } from "vitest";
import { acknowledgeVisibility, feedbackRowDisplay } from "./tip-bubble-host";

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

describe("feedbackRowDisplay", () => {
  it("gives the row's anchor the bubble slot and the waiting tip's anchor a dot", () => {
    expect(feedbackRowDisplay("row", "next", ["summary"])).toEqual({
      bubbleAnchorId: "row",
      dotAnchorIds: ["summary", "next"],
    });
  });

  it("never dots the anchor the row stands on", () => {
    // Right after "Dismiss" the rotation still points at the dismissed tip,
    // whose anchor is the row's; a later tip may ride the same anchor too.
    expect(feedbackRowDisplay("row", "row", ["row", "summary"])).toEqual({
      bubbleAnchorId: "row",
      dotAnchorIds: ["summary"],
    });
  });

  it("keeps the other dots when no tip is waiting", () => {
    expect(feedbackRowDisplay("row", null, ["summary"])).toEqual({
      bubbleAnchorId: "row",
      dotAnchorIds: ["summary"],
    });
  });
});
