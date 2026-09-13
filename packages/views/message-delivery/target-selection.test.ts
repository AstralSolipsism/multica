// @vitest-environment node

import { describe, expect, it } from "vitest";
import { anchorAfterChatChange, anchorAfterMessageEdit } from "./target-selection";

// Canonical matrix for the group/topic target field transitions (OL-74 P2-1).
// The dialog suites cover the wiring; every rule lives here.

describe("anchorAfterChatChange", () => {
  it("keeps the anchor triple when the chat is unchanged", () => {
    const anchor = { messageId: "om_1", threadId: "omt_1", summary: "hello" };
    expect(anchorAfterChatChange("oc_a", "oc_a", anchor)).toEqual(anchor);
  });

  it("clears the whole anchor triple when the chat changes", () => {
    expect(
      anchorAfterChatChange("oc_a", "oc_b", { messageId: "om_1", threadId: "omt_1", summary: "hello" }),
    ).toEqual({ messageId: "", threadId: "", summary: "" });
  });
});

describe("anchorAfterMessageEdit", () => {
  it("keeps thread and summary when the message is unchanged (untouched saved route)", () => {
    const anchor = { messageId: "om_old", threadId: "omt_old", summary: "" };
    expect(anchorAfterMessageEdit("om_old", "om_old", anchor)).toEqual(anchor);
  });

  it("adopts the new message but drops the old thread and summary", () => {
    expect(
      anchorAfterMessageEdit("om_old", "om_new", { messageId: "om_old", threadId: "omt_old", summary: "x" }),
    ).toEqual({ messageId: "om_new", threadId: "", summary: "" });
  });
});
