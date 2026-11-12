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
  wikiDiffHasChanges,
  type WikiBlockDiffEntry,
  type WikiStructureSnapshot,
} from "./baseline-wiki-diff";
function modEntries(diff: WikiBlockDiffEntry[]) {
  return diff.filter((entry): entry is Extract<typeof entry, { op: "mod" }> => entry.op === "mod");
}

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

  it("detects GFM tables from delimiter rows with alignment", () => {
    const blocks = splitWikiBlocks("| a | b |\n| :--- | ---: |\n| 1 | 2 |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("table");
    expect(blocks[0]?.attrs.align).toBe("left,right");
    expect(blocks[0]?.signature).toContain("align=left,right");
  });

  it("does not mistake ordinary paragraphs for tables", () => {
    expect(splitWikiBlocks("a | b\nstill text")[0]?.kind).toBe("paragraph");
  });

  it("detects task-list checked state from the marker", () => {
    expect(splitWikiBlocks("- [ ] 任务")[0]?.attrs.checked).toBe("false");
    expect(splitWikiBlocks("- [x] 任务")[0]?.attrs.checked).toBe("true");
    expect(splitWikiBlocks("1. [X] done")[0]?.attrs.checked).toBe("true");
    expect(splitWikiBlocks("- plain")[0]?.attrs.checked).toBeUndefined();
  });
});

describe("word tokens carry inline signatures", () => {
  it("keeps whitespace tokens so unchanged runs stay readable", () => {
    expect(tokenizeWikiBlock("a b").map((token) => token.text)).toContain(" ");
    const diff = diffWikiTokens(tokenizeWikiBlock("The quick fox"), tokenizeWikiBlock("The quick cat"));
    const sameText = diff.filter((entry) => entry.op === "same").map((entry) => entry.text).join("");
    expect(sameText).toBe("The quick ");
  });

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

  const formattingCases: { name: string; before: string; after: string }[] = [
    { name: "link href", before: "看 [规范](/old)。", after: "看 [规范](/new)。" },
    { name: "wiki target", before: "见 [[overview]]。", after: "见 [[architecture]]。" },
    { name: "img src", before: "标志 ![图](/a.png) 收", after: "标志 ![图](/b.png) 收" },
    { name: "bold added", before: "必须 遵守 规范", after: "必须 **遵守** 规范" },
    { name: "em removed", before: "*重点* 内容", after: "重点 内容" },
    { name: "inline code added", before: "运行 cli 工具", after: "运行 `cli` 工具" },
    { name: "strikethrough removed", before: "~~旧~~ 新方案", after: "旧 新方案" },
  ];

  for (const testCase of formattingCases) {
    it(`token diff marks ${testCase.name} even with identical visible text`, () => {
      const diff = diffWikiTokens(tokenizeWikiBlock(testCase.before), tokenizeWikiBlock(testCase.after));
      expect(diff.some((entry) => entry.op !== "same"), JSON.stringify(diff)).toBe(true);
    });

    it(`block diff renders ${testCase.name} as a mod reflecting the change`, () => {
      const diff = diffWikiMarkdown(testCase.before, testCase.after);
      const mods = modEntries(diff);
      expect(mods, JSON.stringify(diff)).toHaveLength(1);
      const mod = mods[0];
      if (!mod) throw new Error("expected a mod entry");
      expect(
        mod.wordDiff.some((word) => word.op !== "same") || mod.attrChanges.length > 0 || mod.before.signature !== mod.after.signature,
      ).toBe(true);
    });
  }
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
    if (entry?.op !== "mod") throw new Error("expected a mod entry");
    expect(entry.attrChanges.join()).toContain("H2");
    expect(entry.attrChanges.join()).toContain("H3");
  });

  it("marks pure deletions and additions without a counterpart", () => {
    expect(diffWikiMarkdown("保留\n\n删除我", "保留")).toEqual([
      { op: "same", block: expect.objectContaining({ kind: "paragraph" }) },
      { op: "del", block: expect.objectContaining({ source: "删除我" }) },
    ]);
    expect(diffWikiMarkdown("保留", "保留\n\n新增我")).toEqual([
      { op: "same", block: expect.objectContaining({ kind: "paragraph" }) },
      { op: "add", block: expect.objectContaining({ source: "新增我" }) },
    ]);
  });

  it("pairs an adjacent delete+add of mostly-similar text as a modification", () => {
    // "删除我" → "新增我" share zero tokens, so under the ≥ 0.5 hit-rate
    // threshold they must stay separate; this fixture keeps enough shared
    // tokens ("删除" "这一段") to prove the mod path still fires.
    const diff = diffWikiMarkdown("保留\n\n删除这一段内容", "保留\n\n删除这一段文本");
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

describe("mod pairing threshold (#3)", () => {
  it("pairs a one-word paragraph change into a single mod", () => {
    const diff = diffWikiMarkdown("The quick fox", "The quick cat");
    expect(diff).toHaveLength(1);
    const entry = diff[0];
    if (entry?.op !== "mod") throw new Error("expected a mod entry");
    expect(entry.wordDiff.some((word) => word.op !== "same")).toBe(true);
  });

  it("keeps completely different paragraphs of the same kind as separate del + add", () => {
    const diff = diffWikiMarkdown("苹果 香蕉 樱桃", "红色 绿色 蓝色");
    expect(modEntries(diff)).toHaveLength(0);
    expect(diff).toHaveLength(2);
    const del = diff[0];
    const add = diff[1];
    if (del?.op !== "del" || add?.op !== "add") throw new Error("expected separate del then add");
    expect(del.block.source).toBe("苹果 香蕉 樱桃");
    expect(add.block.source).toBe("红色 绿色 蓝色");
  });

  it("N3: hit-rate denominator is max(before, after) tokens, not min", () => {
    // Shared 2 tokens; over the smaller side that is a 1.0 hit rate and would
    // wrongly pair into a mod — over the larger side it is 0.4 < 0.5, so the
    // blocks stay a separate delete + add.
    const diff = diffWikiMarkdown("a b", "a b c d e");
    expect(diff.map((entry) => entry.op)).toEqual(["del", "add"]);
  });

  it("N2: table pairing threshold sits at 0.34 of the larger side", () => {
    // Shared skeleton stays 29 tokens while the after cell grows: 29/85 ≈
    // 0.341 pairs (mod), 29/87 ≈ 0.333 falls below 0.34 and stays del + add.
    const before = "| aa | bb |\n| --- | --- |\n| 1 | 2 |";
    const at = (n: number) => `| cc | dd |\n| --- | --- |\n| ${Array.from({ length: n }, (_, i) => `w${i}`).join(" ")} | z |`;
    expect(diffWikiMarkdown(before, at(27)).map((entry) => entry.op)).toEqual(["mod"]);
    expect(diffWikiMarkdown(before, at(28)).map((entry) => entry.op)).toEqual(["del", "add"]);
  });
});

describe("GFM attribute changes (#4)", () => {
  it("pairs table alignment changes as a mod with an align badge (threshold 0.34)", () => {
    const before = "| a | b |\n| :--- | ---: |\n| 1 | 2 |";
    const after = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const diff = diffWikiMarkdown(before, after);
    const mods = modEntries(diff);
    expect(mods, JSON.stringify(diff)).toHaveLength(1);
    const mod = mods[0];
    if (!mod) throw new Error("expected a mod entry");
    const label = mod.attrChanges.join();
    expect(label).toContain("对齐");
    expect(label).toContain("left");
    expect(label).toContain("right");
  });

  it("pairs a task toggle as a mod with the checkbox badge", () => {
    const diff = diffWikiMarkdown("- [ ] 任务", "- [x] 任务");
    const mods = modEntries(diff);
    expect(mods, JSON.stringify(diff)).toHaveLength(1);
    const mod = mods[0];
    if (!mod) throw new Error("expected a mod entry");
    expect(mod.attrChanges.join()).toContain("☐ → ☑");
  });

  it("pairs an ordered/unordered swap as a mod with the list-type badge", () => {
    const diff = diffWikiMarkdown("- one\n- two", "1. one\n2. two");
    const mods = modEntries(diff);
    expect(mods, JSON.stringify(diff)).toHaveLength(1);
    const mod = mods[0];
    if (!mod) throw new Error("expected a mod entry");
    const label = mod.attrChanges.join();
    expect(label).toContain("无序");
    expect(label).toContain("有序");
  });
});

describe("exact-source block equality (#12)", () => {
  it("surfaces indentation-only changes instead of an empty diff", () => {
    const before = "first\nsecond";
    const after = "first\n  second";
    const diff = diffWikiMarkdown(before, after);
    expect(diff.some((entry) => entry.op !== "same"), JSON.stringify(diff)).toBe(true);
    expect(wikiDiffHasChanges(before, after, [])).toBe(true);
  });

  it("surfaces hard-break deletions instead of an empty diff", () => {
    const before = "line one  \nline two";
    const after = "line one\nline two";
    const diff = diffWikiMarkdown(before, after);
    expect(diff.some((entry) => entry.op !== "same"), JSON.stringify(diff)).toBe(true);
    expect(wikiDiffHasChanges(before, after, [])).toBe(true);
  });

  it("still reports a change when the block diff shows no non-same entry", () => {
    // Defensive branch: any raw-source difference is a change even if the
    // matcher produces no visible marker.
    expect(wikiDiffHasChanges("正文 ", "正文", [])).toBe(true);
  });
});

describe("whole-block fallback (#5)", () => {
  it("fires for differences invisible to tokens (zero-width characters)", () => {
    // U+FEFF is invisible in rendering and stripped from token text, so both
    // paragraphs tokenize identically while their sources differ — the
    // fallback must emit the full sources as del+add.
    const before = "alpha\uFEFFbeta";
    const after = "alphabeta";
    const diff = diffWikiMarkdown(before, after);
    expect(modEntries(diff)).toHaveLength(1);
    const mod = diff[0];
    if (mod?.op !== "mod") throw new Error("expected a mod entry");
    expect(mod.wordDiff).toEqual([
      { op: "del", text: before, signature: "block" },
      { op: "add", text: after, signature: "block" },
    ]);
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

describe("inter-block whitespace changes (contract §7.4 item 6)", () => {
  it("marks a blank-line count change between identical paragraphs", () => {
    const before = "第一段。\n\n第二段。";
    const after = "第一段。\n\n\n第二段。";
    const diff = diffWikiMarkdown(before, after);
    expect(diff.some((entry) => entry.op !== "same")).toBe(true);
    expect(wikiDiffHasChanges(before, after, [])).toBe(true);
    // The fallback is a single whole-body mod with both sources.
    const mod = diff.find((entry) => entry.op === "mod");
    expect(mod).toBeDefined();
    if (mod?.op === "mod") {
      expect(mod.before.source).toBe(before);
      expect(mod.after.source).toBe(after);
    }
  });

  it("marks trailing whitespace changes lost by block splitting", () => {
    const before = "段落一。\n\n";
    const after = "段落一。\n";
    expect(diffWikiMarkdown(before, after).some((entry) => entry.op !== "same")).toBe(true);
  });

  it("marks a reference definition change with unchanged visible prose", () => {
    const before = "[ref]: /old\n\nRead [the rules][ref].";
    const after = "[ref]: /new\n\nRead [the rules][ref].";
    expect(diffWikiMarkdown(before, after).some((entry) => entry.op !== "same")).toBe(true);
  });
});
