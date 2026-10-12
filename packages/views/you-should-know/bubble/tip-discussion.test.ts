// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isTipIssuePath, issueCommentDraftKey, tipDiscussionQuote } from "./tip-discussion";

describe("tipDiscussionQuote", () => {
  it("quotes the tag and line, then the explanation after an empty quote line", () => {
    expect(
      tipDiscussionQuote(
        "You should know",
        "The agent put the feature behind a flag",
        "It ships dark until the flag is turned on.",
      ),
    ).toBe(
      [
        "> ✦ You should know · The agent put the feature behind a flag",
        ">",
        "> It ships dark until the flag is turned on.",
      ].join("\n"),
    );
  });

  it("keeps a multi-line explanation inside the quote", () => {
    expect(tipDiscussionQuote("提个醒", "改了接口", "第一行\r\n\n第二行")).toBe(
      ["> ✦ 提个醒 · 改了接口", ">", "> 第一行", ">", "> 第二行"].join("\n"),
    );
  });

  it("quotes the line alone when there is no explanation", () => {
    expect(tipDiscussionQuote("Heads up", "  Kept the old API  ", null)).toBe(
      "> ✦ Heads up · Kept the old API",
    );
    expect(tipDiscussionQuote("Heads up", "Kept the old API", "  \n ")).toBe(
      "> ✦ Heads up · Kept the old API",
    );
  });
});

describe("isTipIssuePath", () => {
  const issueDetail = (id: string) => `/acme/issues/${encodeURIComponent(id)}`;
  const tip = { issue_id: "uuid-1", issue_identifier: "OL-1" };

  it("matches the issue page by identifier or by UUID", () => {
    expect(isTipIssuePath("/acme/issues/OL-1", tip, issueDetail)).toBe(true);
    expect(isTipIssuePath("/acme/issues/uuid-1", tip, issueDetail)).toBe(true);
  });

  it("does not match other pages", () => {
    expect(isTipIssuePath("/acme/issues", tip, issueDetail)).toBe(false);
    expect(isTipIssuePath("/acme/issues/OL-2", tip, issueDetail)).toBe(false);
    expect(isTipIssuePath("/acme/inbox", tip, issueDetail)).toBe(false);
  });

  it("never matches the issue list through an empty identifier", () => {
    const blank = { issue_id: "uuid-1", issue_identifier: "" };
    expect(isTipIssuePath("/acme/issues/", blank, issueDetail)).toBe(false);
    expect(isTipIssuePath("/acme/issues/uuid-1", blank, issueDetail)).toBe(true);
  });
});

describe("issueCommentDraftKey", () => {
  it("is the top-level composer's draft key", () => {
    expect(issueCommentDraftKey("uuid-1")).toBe("new:uuid-1");
  });
});
