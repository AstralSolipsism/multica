import { locateReplyAnnotation } from "@multica/core/drafts/reply-annotation";
import { BASELINE_ANNOTATION_QUOTE_LIMIT } from "@multica/core/projects/baseline-annotation-draft-store";
import { indexCommentText } from "../../issues/components/comment-annotation-selection";

export interface BaselineTextAnchor {
  quote?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
}

export interface CapturedBaselineText {
  quote: string;
  start: number;
  prefix: string;
  suffix: string;
  lineStart?: number;
  lineEnd?: number;
  range: Range;
  root: HTMLElement;
}

export interface BaselineTextLocation {
  location: "exact" | "moved" | "section_only";
  range: Range | null;
  start: number | null;
}

function codePointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function sourceBlock(node: Node, root: HTMLElement): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>("[data-source-start][data-source-end]") ?? null;
  return block && root.contains(block) ? block : null;
}

export function baselineSourceBlockForLines(root: HTMLElement, lineStart: number, lineEnd = lineStart): HTMLElement | null {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")).filter((block) => {
    const start = Number(block.dataset.sourceStart);
    const end = Number(block.dataset.sourceEnd);
    return start <= lineStart && end >= lineEnd;
  });
  return blocks.sort((a, b) => {
    const aSpan = Number(a.dataset.sourceEnd) - Number(a.dataset.sourceStart);
    const bSpan = Number(b.dataset.sourceEnd) - Number(b.dataset.sourceStart);
    return aSpan - bSpan || Number(b.dataset.sourceStart) - Number(a.dataset.sourceStart);
  })[0] ?? null;
}

export function captureBaselineTextRange(article: HTMLElement, selection: Selection | null): CapturedBaselineText | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const root = article.querySelector<HTMLElement>("[data-baseline-markdown]");
  if (!root) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const { text, nodes } = indexCommentText(root);
  const selected = nodes.filter(({ node }) => range.intersectsNode(node));
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  const start = first.start + (range.startContainer === first.node ? range.startOffset : 0);
  const rawEnd = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length);
  const quote = codePointSlice(text.slice(start, rawEnd), 0, BASELINE_ANNOTATION_QUOTE_LIMIT);
  const end = start + quote.length;
  if (!quote.trim()) return null;
  const lastCovered = nodes.filter((node) => node.start < end && node.end > start).at(-1) ?? last;
  const firstBlock = sourceBlock(first.node, root);
  const lastBlock = sourceBlock(lastCovered.node, root);
  const lineStart = Number(firstBlock?.dataset.sourceStart);
  const lineEnd = Number(lastBlock?.dataset.sourceEnd);
  return {
    quote,
    start,
    prefix: codePointSlice(text.slice(0, start), -64),
    suffix: codePointSlice(text.slice(end), 0, 64),
    ...(firstBlock && lastBlock && Number.isInteger(lineStart) && Number.isInteger(lineEnd) ? { lineStart, lineEnd } : {}),
    range: range.cloneRange(),
    root,
  };
}

export function locateBaselineTextAnnotation(root: HTMLElement, annotation: BaselineTextAnchor): BaselineTextLocation {
  const quote = annotation.quote ?? "";
  if (!quote) return { location: "section_only", range: null, start: null };
  const { text, nodes } = indexCommentText(root);
  const start = locateReplyAnnotation(text, {
    id: "baseline",
    sourceCommentId: "baseline",
    sourceActorName: "baseline",
    note: "baseline",
    quote,
    prefix: annotation.prefix ?? "",
    suffix: annotation.suffix ?? "",
    start: annotation.start ?? 0,
  });
  if (start === null) return { location: "section_only", range: null, start: null };
  const end = start + quote.length;
  const first = nodes.find((node) => node.start <= start && node.end > start);
  const last = nodes.find((node) => node.start < end && node.end >= end);
  if (!first || !last) return { location: "section_only", range: null, start: null };
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return { location: start === annotation.start ? "exact" : "moved", range, start };
}

export function baselineTextAnnotationAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  annotations: readonly (BaselineTextAnchor & { id: string })[],
): string | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  const caret = doc.caretRangeFromPoint?.(clientX, clientY);
  const node = position?.offsetNode ?? caret?.startContainer;
  const offset = position?.offset ?? caret?.startOffset;
  if (!node || offset === undefined || !root.contains(node)) return null;
  const { nodes } = indexCommentText(root);
  const indexed = nodes.find((item) => item.node === node);
  if (!indexed) return null;
  const point = indexed.start + offset;
  for (const annotation of annotations) {
    const location = locateBaselineTextAnnotation(root, annotation);
    if (location.start !== null && point >= location.start && point < location.start + (annotation.quote?.length ?? 0)) return annotation.id;
  }
  return null;
}
