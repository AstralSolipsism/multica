import { describe, expect, it } from "vitest";
import {
  baselineSourceBlockForLines,
  captureBaselineTextRange,
  locateBaselineTextAnnotation,
} from "./engineering-baseline-text-annotations";

function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function fixture() {
  document.body.innerHTML = '<article><h3>Section</h3><div data-baseline-markdown><div data-source-start="2" data-source-end="5"><p data-source-start="2" data-source-end="2">Hello world</p><p data-source-start="4" data-source-end="5">Second block</p></div></div></article>';
  return {
    article: document.querySelector("article")!,
    root: document.querySelector<HTMLElement>("[data-baseline-markdown]")!,
    paragraphs: document.querySelectorAll("p"),
  };
}

describe("baseline text annotations", () => {
  it("captures one section-root selection with rendered context and source block lines", () => {
    const { article, paragraphs } = fixture();
    const captured = captureBaselineTextRange(article, select(paragraphs[0]!.firstChild!, 6, paragraphs[1]!.firstChild!, 6))!;
    expect(captured).toMatchObject({
      quote: "world\nSecond",
      lineStart: 2,
      lineEnd: 5,
      prefix: "Hello ",
      suffix: " block\n",
    });
    expect(captured.range.startContainer).toBe(paragraphs[0]!.firstChild);
  });

  it("rejects selections outside the article's Markdown root", () => {
    const { article } = fixture();
    const outside = document.createElement("p");
    outside.textContent = "Outside";
    document.body.append(outside);
    expect(captureBaselineTextRange(article, select(outside.firstChild!, 0, outside.firstChild!, 3))).toBeNull();
  });

  it("uses the smallest source block containing the anchored lines", () => {
    const { root, paragraphs } = fixture();
    expect(baselineSourceBlockForLines(root, 2, 2)).toBe(paragraphs[0]);
    expect(baselineSourceBlockForLines(root, 2, 5)).toBe(paragraphs[0]!.parentElement);
  });

  it("relocates only a unique quote with context and reports moved offsets", () => {
    const { root, paragraphs } = fixture();
    const text = paragraphs[0]!.firstChild!;
    const location = locateBaselineTextAnnotation(root, { quote: "world", prefix: "Hello ", suffix: "\nSecond", start: 3 });
    expect(location.location).toBe("moved");
    expect(location.start).toBe(6);
    expect(location.range?.startContainer).toBe(text);
    expect(location.range?.toString()).toBe("world");
  });

  it.each([
    { prefix: "", suffix: "", quote: "missing" },
    { prefix: "", suffix: "", quote: "l" },
  ])("falls back to the section when relocation is absent or ambiguous", (anchor) => {
    const { root } = fixture();
    expect(locateBaselineTextAnnotation(root, anchor)).toEqual({ location: "section_only", range: null, start: null });
  });
});
