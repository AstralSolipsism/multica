// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  baselineSourceLines,
  diffBaselineSourceLines,
  diffBaselineSourceSection,
  findBaselineSourceSection,
  foldBaselineSourceDiff,
  type BaselineSourceDiffRow,
} from "./baseline-source-diff";

describe("findBaselineSourceSection", () => {
  it("matches server anchors, ignores fenced headings, and preserves original section Markdown", () => {
    const parent = "## [RULE-1]  Settlement   Rules  \r\n  body  \r\n```md\r\n## Fake\r\n```\r\n";
    const firstChild = "### Child   Heading\r\nchild\r\n";
    const secondChild = "### Child Heading\r\nsecond\r\n";
    const next = "## Next\r\nnext\r\n";
    const content = `preamble\r\n${parent}${firstChild}${secondChild}${next}`;

    expect(findBaselineSourceSection(content, "RULE-1")).toEqual({
      anchor: "RULE-1",
      title: "Settlement   Rules",
      level: 2,
      ownMarkdown: parent,
      subtreeMarkdown: parent + firstChild + secondChild,
    });
    expect(findBaselineSourceSection(content, "RULE-1 / Child Heading")).toMatchObject({
      title: "Child Heading",
      level: 3,
      ownMarkdown: firstChild,
    });
    expect(findBaselineSourceSection(content, "RULE-1 / Child Heading (2)")?.ownMarkdown).toBe(secondChild);
    expect(findBaselineSourceSection(content, "Fake")).toBeNull();
    expect(findBaselineSourceSection(content, "Next")?.ownMarkdown).toBe(next);
  });

  it("handles closing hashes and tilde fences without normalizing source whitespace", () => {
    const content = "  ## Title ##  \nbody  \n~~~text\n### Not a heading\n~~~\n";
    expect(findBaselineSourceSection(content, "Title")).toEqual({
      anchor: "Title",
      title: "Title",
      level: 2,
      ownMarkdown: content,
      subtreeMarkdown: content,
    });
  });
});

describe("baselineSourceLines", () => {
  it("normalizes line endings and removes exactly one trailing LF", () => {
    expect(baselineSourceLines("a\r\nb\rc\n")).toEqual(["a", "b", "c"]);
    expect(baselineSourceLines("a\n\n")).toEqual(["a", ""]);
    expect(baselineSourceLines("a")).toEqual(["a"]);
    expect(baselineSourceLines("")).toEqual([""]);
  });
});

describe("diffBaselineSourceLines", () => {
  it("emits unified rows with one-based before and after line numbers", () => {
    expect(diffBaselineSourceLines(
      "## Rule\nsame\nold\nend\n",
      "## Rule\nsame\nnew\nadded\nend",
    )).toEqual([
      { kind: "context", text: "## Rule", beforeLine: 1, afterLine: 1 },
      { kind: "context", text: "same", beforeLine: 2, afterLine: 2 },
      { kind: "removed", text: "old", beforeLine: 3, afterLine: null },
      { kind: "added", text: "new", beforeLine: null, afterLine: 3 },
      { kind: "added", text: "added", beforeLine: null, afterLine: 4 },
      { kind: "context", text: "end", beforeLine: 4, afterLine: 5 },
    ]);
  });

  it("handles insertions, deletions, and reordered adjacent edits", () => {
    expect(diffBaselineSourceLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "context", text: "a", beforeLine: 1, afterLine: 1 },
      { kind: "added", text: "b", beforeLine: null, afterLine: 2 },
      { kind: "context", text: "c", beforeLine: 2, afterLine: 3 },
    ]);
    expect(diffBaselineSourceLines("a\nb\nc", "a\nc")).toEqual([
      { kind: "context", text: "a", beforeLine: 1, afterLine: 1 },
      { kind: "removed", text: "b", beforeLine: 2, afterLine: null },
      { kind: "context", text: "c", beforeLine: 3, afterLine: 2 },
    ]);
    expect(diffBaselineSourceLines("a\nb", "b\na").map((row) => row.kind)).toEqual([
      "removed", "context", "added",
    ]);
  });

  it("normalizes CRLF and CR for comparison without inventing a final-line change", () => {
    expect(diffBaselineSourceLines("## R\r\nold\r\n", "## R\rafter\r")).toEqual([
      { kind: "context", text: "## R", beforeLine: 1, afterLine: 1 },
      { kind: "removed", text: "old", beforeLine: 2, afterLine: null },
      { kind: "added", text: "after", beforeLine: null, afterLine: 2 },
    ]);
    expect(diffBaselineSourceLines("same\n", "same")).toEqual([
      { kind: "context", text: "same", beforeLine: 1, afterLine: 1 },
    ]);
    expect(diffBaselineSourceLines("a\n\n", "a\n")).toEqual([
      { kind: "context", text: "a", beforeLine: 1, afterLine: 1 },
      { kind: "removed", text: "", beforeLine: 2, afterLine: null },
    ]);
  });

  it("keeps SourceLines empty-input semantics for empty files and blank lines", () => {
    expect(diffBaselineSourceLines("", "")).toEqual([
      { kind: "context", text: "", beforeLine: 1, afterLine: 1 },
    ]);
    expect(diffBaselineSourceLines("", "new\n")).toEqual([
      { kind: "removed", text: "", beforeLine: 1, afterLine: null },
      { kind: "added", text: "new", beforeLine: null, afterLine: 1 },
    ]);
  });

  it("diffs only the selected section's own Markdown, excluding descendant sections", () => {
    const before = "## A\nsame\n### Child\nold\n## B\nunchanged\n";
    const after = "## A\nsame\n### Child\nnew\n## B\nunchanged\n";
    expect(diffBaselineSourceSection(before, after, "A")).toEqual([
      { kind: "context", text: "## A", beforeLine: 1, afterLine: 1 },
      { kind: "context", text: "same", beforeLine: 2, afterLine: 2 },
    ]);
    expect(diffBaselineSourceSection(before, after, "missing")).toBeNull();
  });
});

describe("foldBaselineSourceDiff", () => {
  const rows: BaselineSourceDiffRow[] = Array.from({ length: 12 }, (_, index) => ({
    kind: "context",
    text: `line ${index}`,
    beforeLine: index + 1,
    afterLine: index + 1,
  }));
  rows[5] = { kind: "removed", text: "old", beforeLine: 6, afterLine: null };
  rows.splice(6, 0, { kind: "added", text: "new", beforeLine: null, afterLine: 6 });

  it("folds unchanged runs while retaining context and required annotation rows", () => {
    const folded = foldBaselineSourceDiff(rows, { context: 1, requiredRowIndexes: [9] });
    expect(folded[0]).toMatchObject({ kind: "folded", count: 4, start: 0, end: 3 });
    expect(folded.slice(1, 5).map((row) => row.kind)).toEqual(["context", "removed", "added", "context"]);
    expect(folded[5]).toMatchObject({ kind: "context", text: "line 7" });
    expect(folded[6]).toMatchObject({ kind: "context", text: "line 8" });
    expect(folded[7]).toMatchObject({ kind: "context", text: "line 9" });
    expect(folded[8]).toMatchObject({ kind: "folded", count: 2, start: 11, end: 12 });
  });

  it("can expand a selected folded block by its original start row", () => {
    const folded = foldBaselineSourceDiff(rows, { context: 1 });
    const starts = folded.filter((row) => row.kind === "folded").map((row) => row.start);
    const expanded = foldBaselineSourceDiff(rows, { context: 1, expandedFoldStarts: [starts[0]!] });

    expect(starts).toEqual([0, 8]);
    expect(expanded[0]).toMatchObject({ kind: "context", text: "line 0" });
    expect(expanded.at(-1)).toMatchObject({ kind: "folded", start: 8, count: 5 });
    expect(foldBaselineSourceDiff(rows, { context: 1, expandedFoldStarts: starts })).toEqual(rows);
  });
});
