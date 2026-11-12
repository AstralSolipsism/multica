import type { WikiCommentAnchor } from "@multica/core/api";

const blocks = new Set(["P", "BR", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "TR", "TD", "TH", "BLOCKQUOTE", "DIV", "UL", "OL", "TABLE", "HR"]);
const noise = '[data-wiki-link-preview], [data-comment-ignore], .code-block-wrapper > div:first-child, button:not([data-wiki-link]), input, textarea, select, svg, [aria-hidden="true"], [hidden]';
interface Point { node: Node; offset: number }
export interface CommentTextIndex {
  text: string;
  starts: Point[];
  ends: Point[];
  range: (start: number, length: number) => Range | null;
}

/** Normalized text retains a DOM point for every UTF-16 unit, without DOM edits. */
export function indexWikiCommentText(root: HTMLElement): CommentTextIndex {
  let text = "", pendingSpace: { start?: Point; end?: Point } | null = null;
  const starts: Point[] = [], ends: Point[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      for (let i = 0; i < value.length; i++) {
        const start = { node: node as Text, offset: i }, end = { node: node as Text, offset: i + 1 };
        if (/\s/.test(value[i]!)) { pendingSpace = { start: pendingSpace?.start ?? start, end }; continue; }
        if (pendingSpace && text) {
          text += " "; starts.push(pendingSpace.start ?? ends.at(-1)!); ends.push(pendingSpace.end ?? start);
        }
        pendingSpace = null; text += value[i]; starts.push(start); ends.push(end);
      }
      return;
    }
    if (!(node instanceof Element) || node.matches(noise)) return;
    // Rendered diagrams/HTML retain the GFM code source as one atomic block.
    // Their preview chrome, SVG labels and iframe contents are not text anchors.
    const source = node.getAttribute("data-wiki-comment-source");
    if (source !== null && node.parentNode) {
      const offset = Array.from(node.parentNode.childNodes).indexOf(node);
      const start = { node: node.parentNode, offset }, end = { node: node.parentNode, offset: offset + 1 };
      const normalized = source.replace(/\s+/g, " ").trim();
      if (normalized) {
        if (text) { text += " "; starts.push(ends.at(-1)!); ends.push(start); }
        for (let i = 0; i < normalized.length; i++) { text += normalized[i]; starts.push(start); ends.push(end); }
      }
      pendingSpace = {};
      return;
    }
    const block = blocks.has(node.tagName);
    if (block) pendingSpace ??= {};
    for (const child of node.childNodes) walk(child);
    if (block) pendingSpace ??= {};
  };
  walk(root);
  return { text, starts, ends, range(start, length) {
    const first = starts[start], last = ends[start + length - 1];
    if (!first || !last) return null;
    const range = root.ownerDocument.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset); return range;
  } };
}

export function wikiSelectionAnchor(root: HTMLElement, selection: Selection | null, revisionNumber: number): { anchor: WikiCommentAnchor; range: Range } | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const selected = selection.getRangeAt(0);
  const element = selected.startContainer.nodeType === Node.ELEMENT_NODE ? selected.startContainer as Element : selected.startContainer.parentElement;
  const section = element?.closest<HTMLElement>("[data-wiki-comment-section]");
  if (!section || !root.contains(section) || element?.closest(`${noise}, [data-wiki-comment-source]`)) return null;
  const textRoot = section.querySelector<HTMLElement>("[data-wiki-markdown]");
  if (!textRoot) return null;
  const index = indexWikiCommentText(textRoot);
  // Range comparisons also truncate a selection spanning into later sections.
  let start = -1, end = -1;
  index.starts.forEach((_point, i) => {
    const char = index.range(i, 1)!;
    // comparePoint includes the selection's end, while text offsets exclude it.
    if (selected.compareBoundaryPoints(Range.END_TO_START, char) < 0 &&
        selected.compareBoundaryPoints(Range.START_TO_END, char) > 0) {
      if (start < 0) start = i;
      end = i + 1;
    }
  });
  if (start < 0) return null;
  const exact = index.text.slice(start, end).trimEnd();
  if ([...exact].length < 2 || [...exact].length > 500) return null;
  const range = index.range(start, exact.length); if (!range) return null;
  return { range, anchor: { kind: "text", sectionAnchor: section.dataset.wikiCommentSection!, sectionTitle: section.dataset.sectionTitle ?? "", exact, prefix: [...index.text.slice(0, start)].slice(-64).join(""), suffix: [...index.text.slice(start + exact.length)].slice(0, 64).join(""), start, revisionNumber } };
}
