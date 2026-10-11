// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scheduleTips, shouldShowSettingsHint, TIP_DWELL_MS } from "./schedule";
import type {
  SchedulableTip,
  TipAnchorDescriptor,
  TipScheduleAnchor,
} from "./types";

let anchorSeq = 0;
function anchor(
  descriptor: TipAnchorDescriptor,
  overrides: Partial<TipScheduleAnchor> = {},
): TipScheduleAnchor {
  anchorSeq += 1;
  return {
    id: `a${anchorSeq}`,
    visible: true,
    top: anchorSeq * 100,
    descriptor,
    ...overrides,
  };
}

function tip(overrides: Partial<SchedulableTip> = {}): SchedulableTip {
  return {
    id: "tip-1",
    issue_id: "issue-1",
    tag: "you_should_know",
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const SUMMARY_SCOPE = { "issue-1": "OL-1", "issue-2": "OL-2" };

describe("scheduleTips — primary position", () => {
  it("prefers the detail header over row and summary candidates", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE }, { top: 10 });
    const row = anchor({ level: "row", issueId: "issue-1" }, { top: 20 });
    const header = anchor({ level: "detail_header", issueId: "issue-1" }, { top: 30 });
    const result = scheduleTips({ anchors: [summary, row, header], tips: [tip()] });
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({
      tipId: "tip-1",
      anchorId: header.id,
      level: "detail_header",
    });
  });

  it("does not pick the detail header when only row and summary are visible", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE }, { top: 10 });
    const row = anchor({ level: "row", issueId: "issue-1" }, { top: 20 });
    const result = scheduleTips({ anchors: [summary, row], tips: [tip()] });
    expect(result.placements[0]).toMatchObject({ anchorId: row.id, level: "row" });
  });

  it("falls back to the summary when neither header nor row is visible", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE });
    const result = scheduleTips({ anchors: [summary], tips: [tip()] });
    expect(result.placements[0]).toMatchObject({
      anchorId: summary.id,
      level: "summary",
    });
  });

  it("breaks same-level ties by page position (higher anchor wins)", () => {
    const lower = anchor({ level: "row", issueId: "issue-1" }, { top: 500 });
    const higher = anchor({ level: "row", issueId: "issue-1" }, { top: 100 });
    const result = scheduleTips({ anchors: [lower, higher], tips: [tip()] });
    expect(result.placements[0]!.anchorId).toBe(higher.id);
    expect(result.placements[0]!.anchorId).not.toBe(lower.id);
  });

  it("keeps input order when same-level anchors share a page position", () => {
    const first = anchor({ level: "row", issueId: "issue-1" }, { top: 0 });
    const second = anchor({ level: "row", issueId: "issue-1" }, { top: 0 });
    const result = scheduleTips({ anchors: [first, second], tips: [tip()] });
    expect(result.placements[0]!.anchorId).toBe(first.id);
  });
});

describe("scheduleTips — candidates and summary de-dup", () => {
  it("treats invisible anchors as non-candidates", () => {
    const hiddenRow = anchor({ level: "row", issueId: "issue-1" }, { visible: false });
    const result = scheduleTips({ anchors: [hiddenRow], tips: [tip()] });
    expect(result.placements).toHaveLength(0);
    expect(result.queue).toHaveLength(0);
    expect(result.dotAnchorIds).toHaveLength(0);
  });

  it("uses an anchor once it becomes visible", () => {
    const row = anchor({ level: "row", issueId: "issue-1" }, { visible: true });
    const result = scheduleTips({ anchors: [row], tips: [tip()] });
    expect(result.placements[0]!.anchorId).toBe(row.id);
  });

  it("skips an invisible detail header and lands on the visible row", () => {
    const header = anchor(
      { level: "detail_header", issueId: "issue-1" },
      { visible: false, top: 10 },
    );
    const row = anchor({ level: "row", issueId: "issue-1" }, { top: 20 });
    const result = scheduleTips({ anchors: [header, row], tips: [tip()] });
    expect(result.placements[0]).toMatchObject({ anchorId: row.id, level: "row" });
  });

  it("never primaries a summary while the issue has a visible row (de-dup)", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE }, { top: 10 });
    const row = anchor({ level: "row", issueId: "issue-1" }, { top: 20 });
    const result = scheduleTips({ anchors: [summary, row], tips: [tip()] });
    expect(result.placements[0]!.level).not.toBe("summary");
    expect(result.queue.every((entry) => entry.level !== "summary")).toBe(true);
  });

  it("lets the summary rotate the tip once no row or header is visible", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE });
    const row = anchor(
      { level: "row", issueId: "issue-1" },
      { visible: false },
    );
    const result = scheduleTips({ anchors: [summary, row], tips: [tip()] });
    expect(result.queue[0]).toMatchObject({ level: "summary", anchorId: summary.id });
  });

  it("does not treat a summary whose scope lacks the issue as a candidate", () => {
    const summary = anchor({ level: "summary", scope: { "issue-9": "OL-9" } });
    const result = scheduleTips({ anchors: [summary], tips: [tip()] });
    expect(result.placements).toHaveLength(0);
  });

  it("does not place a tip on another issue's row", () => {
    const row = anchor({ level: "row", issueId: "issue-2" });
    const result = scheduleTips({ anchors: [row], tips: [tip()] });
    expect(result.placements).toHaveLength(0);
  });
});

describe("scheduleTips — dots", () => {
  it("lights every candidate except the anchor hosting the bubble", () => {
    const header = anchor({ level: "detail_header", issueId: "issue-1" }, { top: 10 });
    const row = anchor({ level: "row", issueId: "issue-1" }, { top: 20 });
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE }, { top: 30 });
    const result = scheduleTips({ anchors: [header, row, summary], tips: [tip()] });
    // Bubble sits on the detail header (queue head); row + summary carry dots.
    expect(result.queue[0]!.anchorId).toBe(header.id);
    expect(result.dotAnchorIds).toEqual(expect.arrayContaining([row.id, summary.id]));
    expect(result.dotAnchorIds).not.toContain(header.id);
  });

  it("lights no dot on an anchor that is no tip's candidate", () => {
    const row = anchor({ level: "row", issueId: "issue-1" });
    const unrelated = anchor({ level: "row", issueId: "issue-2" });
    const result = scheduleTips({ anchors: [row, unrelated], tips: [tip()] });
    expect(result.dotAnchorIds).not.toContain(unrelated.id);
  });

  it("lights no dots at all when nothing is displayable", () => {
    const row = anchor({ level: "row", issueId: "issue-1" });
    const result = scheduleTips({ anchors: [row], tips: [] });
    expect(result.dotAnchorIds).toHaveLength(0);
  });
});

describe("scheduleTips — rotation queue", () => {
  it("rotates heads-up tips ahead of you-should-know ones", () => {
    const rowA = anchor({ level: "row", issueId: "issue-1" }, { top: 10 });
    const headerB = anchor({ level: "detail_header", issueId: "issue-2" }, { top: 20 });
    const result = scheduleTips({
      anchors: [rowA, headerB],
      tips: [
        tip({ id: "light", issue_id: "issue-1", tag: "you_should_know" }),
        tip({ id: "hu", issue_id: "issue-2", tag: "heads_up" }),
      ],
    });
    // The heads-up leads even though its primary (header) comes after the row.
    expect(result.queue.map((entry) => entry.tipId)).toEqual(["hu", "light"]);
  });

  it("orders same-tag tips by primary level, then page position, then creation time", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE }, { top: 5 });
    const rowLow = anchor({ level: "row", issueId: "issue-1" }, { top: 300 });
    const rowHigh = anchor({ level: "row", issueId: "issue-2" }, { top: 100 });
    const older = tip({ id: "older", issue_id: "issue-1", created_at: "2026-10-01T00:00:00Z" });
    const newer = tip({ id: "newer", issue_id: "issue-1", created_at: "2026-10-02T00:00:00Z" });
    const other = tip({ id: "other", issue_id: "issue-2" });
    const result = scheduleTips({
      anchors: [summary, rowLow, rowHigh],
      tips: [newer, older, other],
    });
    // row (top 100) before row (top 300); the two tips sharing the lower row
    // go oldest first; the summary primary trails the rows.
    expect(result.queue.map((entry) => entry.tipId)).toEqual([
      "other",
      "older",
      "newer",
    ]);
  });

  it("assigns dwell by tag: 8s for you-should-know, 15s for heads-up", () => {
    const rowA = anchor({ level: "row", issueId: "issue-1" });
    const rowB = anchor({ level: "row", issueId: "issue-2" });
    const result = scheduleTips({
      anchors: [rowA, rowB],
      tips: [
        tip({ id: "light", issue_id: "issue-1", tag: "you_should_know" }),
        tip({ id: "hu", issue_id: "issue-2", tag: "heads_up" }),
      ],
    });
    const byId = new Map(result.queue.map((entry) => [entry.tipId, entry]));
    expect(byId.get("light")!.dwellMs).toBe(8_000);
    expect(byId.get("hu")!.dwellMs).toBe(15_000);
    expect(byId.get("light")!.dwellMs).not.toBe(TIP_DWELL_MS.heads_up);
  });

  it("excludes tips without any visible candidate from the queue", () => {
    const row = anchor({ level: "row", issueId: "issue-1" });
    const result = scheduleTips({
      anchors: [row],
      tips: [tip(), tip({ id: "stray", issue_id: "issue-9" })],
    });
    expect(result.queue.map((entry) => entry.tipId)).toEqual(["tip-1"]);
  });
});

describe("scheduleTips — summary identifier", () => {
  it("carries the issue identifier when the primary is a summary", () => {
    const summary = anchor({ level: "summary", scope: SUMMARY_SCOPE });
    const result = scheduleTips({ anchors: [summary], tips: [tip()] });
    expect(result.placements[0]!.issueIdentifier).toBe("OL-1");
    expect(result.queue[0]!.issueIdentifier).toBe("OL-1");
  });

  it("carries no identifier for row or detail-header primaries", () => {
    const row = anchor({ level: "row", issueId: "issue-1" });
    const result = scheduleTips({ anchors: [row], tips: [tip()] });
    expect(result.placements[0]!.issueIdentifier).toBeNull();
    expect(result.queue[0]!.issueIdentifier).toBeNull();
  });
});

describe("scheduleTips — re-scheduling does not interrupt", () => {
  it("keeps a still-valid current tip at the queue head", () => {
    const rowA = anchor({ level: "row", issueId: "issue-1" }, { top: 10 });
    const rowB = anchor({ level: "row", issueId: "issue-2" }, { top: 20 });
    const tips = [
      tip({ id: "current", issue_id: "issue-2", tag: "you_should_know" }),
      tip({ id: "breaking", issue_id: "issue-1", tag: "heads_up" }),
    ];
    const result = scheduleTips({
      anchors: [rowA, rowB],
      tips,
      current: { tipId: "current" },
    });
    // Rule order would lead with the heads-up; the showing tip is pinned.
    expect(result.queue[0]!.tipId).toBe("current");
    expect(result.queue[1]!.tipId).toBe("breaking");
    // The bubble anchor is the pinned tip's primary, so dots skip it.
    expect(result.dotAnchorIds).not.toContain(rowB.id);
    expect(result.dotAnchorIds).toContain(rowA.id);
  });

  it("drops the pin when the current tip is no longer valid", () => {
    const rowA = anchor({ level: "row", issueId: "issue-1" }, { top: 10 });
    const rowB = anchor(
      { level: "row", issueId: "issue-2" },
      { top: 20, visible: false },
    );
    const result = scheduleTips({
      anchors: [rowA, rowB],
      tips: [
        tip({ id: "current", issue_id: "issue-2" }),
        tip({ id: "next", issue_id: "issue-1" }),
      ],
      current: { tipId: "current" },
    });
    // "current" lost its only candidate (rowB hidden) and leaves the queue.
    expect(result.queue.map((entry) => entry.tipId)).toEqual(["next"]);
  });

  it("drops the pin when the current tip left the tip list", () => {
    const row = anchor({ level: "row", issueId: "issue-1" });
    const result = scheduleTips({
      anchors: [row],
      tips: [tip({ id: "next" })],
      current: { tipId: "gone" },
    });
    expect(result.queue.map((entry) => entry.tipId)).toEqual(["next"]);
  });
});

describe("shouldShowSettingsHint", () => {
  it("shows on the first three displays", () => {
    expect(shouldShowSettingsHint(1)).toBe(true);
    expect(shouldShowSettingsHint(2)).toBe(true);
    expect(shouldShowSettingsHint(3)).toBe(true);
  });

  it("stays quiet between the fourth and ninth display", () => {
    for (const n of [4, 5, 6, 7, 8, 9]) {
      expect(shouldShowSettingsHint(n)).toBe(false);
    }
  });

  it("shows again on every tenth display", () => {
    for (const n of [10, 20, 30, 100]) {
      expect(shouldShowSettingsHint(n)).toBe(true);
    }
    expect(shouldShowSettingsHint(11)).toBe(false);
    expect(shouldShowSettingsHint(21)).toBe(false);
  });
});
