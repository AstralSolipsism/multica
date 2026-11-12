// @vitest-environment node
// Rich-diff fixtures per the OL-1329 contract §7.4 item 8 plus the
// "never-empty diff" property the review matrix pins.
import { describe, expect, it } from "vitest";
import {
  diffSequence,
  diffWikiMarkdown,
  diffWikiSourceLines,
  diffWikiStructure,
  splitWikiBlocks,
  tokenizeWikiBlock,
  diffWikiTokens,
  type WikiStructureSnapshot,
} from "./baseline-wiki-diff";

describe("diffSequence", () => {
  it("aligns a simple edit", () => {
    const ops = diffSequence(["a", "b", "c"], ["a", "x", "c"], (x, y) => x === y);
    expect(ops).toEqual([
      { op: "same", aIndex: 0, bIndex: 0 },
      { op: "del", aIndex: 1 },
      { op: "add", bIndex: 1 },
      { op: "same", aIndex: 2, bIndex: 2 },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffSequence([], ["x"], (a, b) => a === b)).toEqual([{ op: "add", bIndex: 0 }]);
    expect(diffSequence(["x"], [], (a, b) => a === b)).toEqual([{ op: "del", aIndex: 0 }]);
  });
});

describe("block splitting", () => {
  it("splits top-level blocks and captures signatures", () => {
    const blocks = splitWikiBlocks("# Title\n\nPara.\n\n```ts\ncode\n```\n\n- one\n");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "code", "list"]);
    expect(blocks[0]?.attrs.depth).toBe("1");
    expect(blocks[2]?.attrs.lang).toBe("ts");
  });
});

describe("word tokens carry inline signatures", () => {
  it("changes in link targets are visible even with identical text", () => {
    const before = tokenizeWikiBlock("see [规范](/old)");
    const after = tokenizeWikiBlock("see [规范](/new)");
    const diff = diffWikiTokens(before, after);
    expect(diff.some((entry) => entry.op === "del")).toBe(true);
    expect(diff.some((entry) => entry.op === "add")).toBe(true);
  });

  it("bold removal is a change", () => {
    const before = tokenizeWikiBlock("必须 **严格** 遵守");
    const after = tokenizeWikiBlock("必须 严格 遵守");
    const diff = diffWikiTokens(before, after);
    expect(diff.some((entry) => entry.op !== "same")).toBe(true);
  });

  it("wiki link target changes are visible", () => {
    const before = tokenizeWikiBlock("见 [[overview]]");
    const after = tokenizeWikiBlock("见 [[architecture]]");
    const diff = diffWikiTokens(before, after);
    expect(diff.some((entry) => entry.op === "del" && entry.text.includes("overview"))).toBe(true);
    expect(diff.some((entry) => entry.op === "add" && entry.text.includes("architecture"))).toBe(true);
  });

  it("image source changes are visible", () => {
    const diff = diffWikiTokens(tokenizeWikiBlock("![logo](/a.png)"), tokenizeWikiBlock("![logo](/b.png)"));
    expect(diff.some((entry) => entry.op !== "same")).toBe(true);
  });
});

const richDiffCases: { name: string; before: string; after: string }[] = [
  { name: "link target", before: "看 [规范](/old)。", after: "看 [规范](/new)。" },
  { name: "wiki target", before: "见 [[overview]]。", after: "见 [[architecture]]。" },
  { name: "image src", before: "![图](/a.png)", after: "![图](/b.png)" },
  { name: "bold added", before: "必须遵守", after: "必须**遵守**" },
  { name: "italic removed", before: "*重点* 内容", after: "重点 内容" },
  { name: "inline code added", before: "运行 cli", after: "运行 `cli`" },
  { name: "strikethrough removed", before: "~~旧方案~~ 新方案", after: "新方案" },
  { name: "heading level", before: "## 标题\n正文", after: "### 标题\n正文" },
  { name: "task checked", before: "- [ ] 任务", after: "- [x] 任务" },
  { name: "list type", before: "- one\n- two", after: "1. one\n2. two" },
  { name: "code language", before: "```ts\ncode\n```", after: "```go\ncode\n```" },
  { name: "table content", before: "| a | b |\n| - | - |\n| 1 | 2 |", after: "| a | b |\n| - | - |\n| 1 | 3 |" },
  { name: "code body", before: "```ts\nfoo()\n```", after: "```ts\nbar()\n```" },
];

describe("diffWikiMarkdown fixtures (contract §7.4 item 8)", () => {
  for (const testCase of richDiffCases) {
    it(`marks a visible change for ${testCase.name}`, () => {
      const diff = diffWikiMarkdown(testCase.before, testCase.after);
      const visible = diff.filter((entry) => entry.op !== "same");
      expect(visible.length, JSON.stringify(diff)).toBeGreaterThan(0);
      for (const entry of visible) {
        if (entry.op === "mod") {
          // A modification must carry either token-level or attribute changes.
          expect(
            entry.wordDiff.some((word) => word.op !== "same") || entry.attrChanges.length > 0 || entry.before.signature !== entry.after.signature,
          ).toBe(true);
        }
      }
    });
  }

  it("pairs adjacent heading changes as one modification with an attribute badge", () => {
    const diff = diffWikiMarkdown("## 标题\n正文", "### 标题\n正文").filter((entry) => entry.op !== "same");
    expect(diff).toHaveLength(1);
    const entry = diff[0];
    if (entry?.op === "mod") expect(entry.attrChanges.join()).toContain("H2");
  });

  it("marks pure deletions and additions without a counterpart", () => {
    expect(diffWikiMarkdown("保留\n\n删除我", "保留")).toEqual([
      { op: "same", block: expect.objectContaining({ kind: "paragraph" }) },
      { op: "del", block: expect.objectContaining({ normalized: "删除我" }) },
    ]);
    expect(diffWikiMarkdown("保留", "保留\n\n新增我")).toEqual([
      { op: "same", block: expect.objectContaining({ kind: "paragraph" }) },
      { op: "add", block: expect.objectContaining({ normalized: "新增我" }) },
    ]);
  });

  it("pairs an adjacent delete+add of the same kind as a modification", () => {
    const diff = diffWikiMarkdown("保留\n\n删除我", "保留\n\n新增我");
    expect(diff).toEqual([
      { op: "same", block: expect.anything() },
      expect.objectContaining({ op: "mod" }),
    ]);
  });

  it("returns an empty diff only for identical sources", () => {
    expect(diffWikiMarkdown("相同\n\n内容", "相同\n\n内容")).toEqual([]);
  });

  it("never produces an empty diff when sources differ (fallback included)", () => {
    // HTML blocks stress the signature blind spots: word diff may see nothing,
    // so the whole-block fallback must kick in.
    const pairs: [string, string][] = [
      ["<span data-x=1>a</span>", "<span data-x=2>a</span>"],
      ...richDiffCases.map((c) => [c.before, c.after] as [string, string]),
    ];
    for (const [before, after] of pairs) {
      if (before === after) continue;
      const diff = diffWikiMarkdown(before, after);
      expect(
        diff.some((entry) => entry.op !== "same"),
        `sources differ but no marker: ${JSON.stringify({ before, after })}`,
      ).toBe(true);
    }
  });
});

describe("structure metadata bar", () => {
  const before: WikiStructureSnapshot = { title: "A", slug: "a", parent: null, position: 0, archived: false };
  it("lists only changed structure fields", () => {
    const after: WikiStructureSnapshot = { ...before, title: "B", position: 3 };
    expect(diffWikiStructure(before, after)).toEqual([
      { field: "title", from: "A", to: "B" },
      { field: "position", from: 0, to: 3 },
    ]);
  });
  it("structure-only revisions produce an empty body diff and a non-empty bar", () => {
    const after: WikiStructureSnapshot = { ...before, archived: true };
    expect(diffWikiMarkdown("正文", "正文")).toEqual([]);
    expect(diffWikiStructure(before, after).length).toBe(1);
  });
});

describe("source line mode", () => {
  it("emits per-line add/del/same", () => {
    const ops = diffWikiSourceLines("a\nb", "a\nc");
    expect(ops.filter((op) => op.op === "same").map((op) => op.text)).toEqual(["a"]);
    expect(ops.filter((op) => op.op === "del").map((op) => op.text)).toEqual(["b"]);
    expect(ops.filter((op) => op.op === "add").map((op) => op.text)).toEqual(["c"]);
  });
});
