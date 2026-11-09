import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent, Code } from "mdast";

/**
 * Fenced-code closedness gate for streaming RichContent (MUL-4922).
 *
 * A Mermaid diagram or sandboxed HTML iframe must never be instantiated from a
 * fence the author is still typing: mid-stream the source is syntactically
 * incomplete, so Mermaid would throw on every keystroke and an iframe would be
 * created and destroyed dozens of times per second. Only a *closed* fence may
 * upgrade to a rich block.
 *
 * This module answers one question — "which fenced code blocks in this source
 * are closed?" — and returns their offsets. Since it holds the only parse that
 * still sees a fence's info string, it also reads the block title and optional
 * HTML attachment source from it (```html title="Weekly p95", MUL-7649):
 * rehype-raw rebuilds the tree and drops the `meta` the code renderer would
 * otherwise have received. It deliberately does NOT render.
 * Rendering stays in the single ReactMarkdown pipeline; a gate that rendered
 * would become the second renderer this sweep exists to delete.
 *
 * Closedness is derived from a real CommonMark parse rather than a
 * `startsWith("```")` scan, so indented fences, tilde fences, longer-than-three
 * markers, fences inside list items, and nested fences are all judged the way
 * the actual Markdown parser judges them.
 */

// Opening fence: up to 3 leading spaces, then >= 3 backticks or tildes.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function isCodeNode(node: RootContent | Root): node is Code {
  return node.type === "code";
}

function collectCodeNodes(node: Root | RootContent, out: Code[]): void {
  if (isCodeNode(node)) {
    out.push(node);
    return;
  }
  const children = (node as { children?: RootContent[] }).children;
  if (children) {
    for (const child of children) collectCodeNodes(child, out);
  }
}

/**
 * True when `raw` (the exact source span of one mdast `code` node) ends with a
 * closing fence valid for its own opener.
 *
 * CommonMark requires the closer to use the same character as the opener and be
 * at least as long, so an opener of ```` closed by ``` is still OPEN — the
 * shorter run is content, not a terminator. Length is checked explicitly
 * because a regex that only matched "a line of >=3 markers" reports that case
 * closed and would let a half-written diagram reach Mermaid.
 */
function endsWithClosingFence(raw: string): boolean {
  const lines = raw.split("\n");
  const openMatch = FENCE_OPEN_RE.exec(lines[0] ?? "");
  // No opener means an indented (4-space) code block. It has no fence to leave
  // dangling, and carries no info string, so it can never dispatch to a rich
  // block — treat it as settled.
  if (!openMatch?.[1]) return true;

  const openFence = openMatch[1];
  const marker = openFence[0] as "`" | "~";
  // A single line cannot be both opener and closer.
  if (lines.length < 2) return false;

  // mdast may or may not include the trailing newline in the node span.
  const lastLine = (lines[lines.length - 1] === "" ? lines[lines.length - 2] : lines[lines.length - 1]) ?? "";
  const closeMatch = /^ {0,3}([`~]+)[ \t]*$/.exec(lastLine);
  if (!closeMatch?.[1]) return false;

  const closeFence = closeMatch[1];
  return closeFence[0] === marker && closeFence.length >= openFence.length;
}

function parseFenceMeta(meta: string | null | undefined): {
  title: string | null;
  src: string | null;
} {
  let title: string | null = null;
  let src: string | null = null;
  let index = 0;
  while (meta && index < meta.length) {
    while (/\s/.test(meta[index] ?? "")) index++;
    const nameStart = index;
    while (/[^\s=]/.test(meta[index] ?? "")) index++;
    const name = meta.slice(nameStart, index);
    if (meta[index] !== "=") continue;
    index++;

    let value = "";
    let valid = true;
    const quote = meta[index];
    if (quote === '"' || quote === "'") {
      index++;
      const valueStart = index;
      while (index < meta.length && meta[index] !== quote) index++;
      value = meta.slice(valueStart, index);
      if (index === meta.length) {
        valid = false;
      } else {
        index++;
        valid = index === meta.length || /\s/.test(meta[index] ?? "");
      }
    } else {
      const valueStart = index;
      while (/\S/.test(meta[index] ?? "")) index++;
      value = meta.slice(valueStart, index);
    }
    if (!valid) continue;

    const normalized = value.trim() || null;
    if (name === "title" && title === null) title = normalized;
    if (name === "src" && src === null) src = normalized;
  }
  return { title, src };
}

/**
 * The `title` attribute of a fence info string, e.g. `title="Weekly p95"` in
 * ```html title="Weekly p95". Double, single or no quotes.
 */
export function parseFenceTitle(meta: string | null | undefined): string | null {
  return parseFenceMeta(meta).title;
}

export interface ClosedFence {
  title: string | null;
  src: string | null;
}

/**
 * Every fenced code block that is closed in `source`, keyed by start offset.
 *
 * `source` MUST be the final processed Markdown handed to ReactMarkdown — the
 * same string preprocess/highlight already rewrote. Offsets computed against
 * the raw pre-preprocess text would drift and mis-match the wrong node.
 */
export function computeClosedFences(source: string): Map<number, ClosedFence> {
  const closed = new Map<number, ClosedFence>();
  if (!source) return closed;

  let tree: Root;
  try {
    tree = fromMarkdown(source);
  } catch {
    // A parse failure must not upgrade anything: fall back to "nothing is
    // closed", which shows source instead of running Mermaid on bad input.
    return closed;
  }

  const codes: Code[] = [];
  collectCodeNodes(tree, codes);

  for (const node of codes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start == null || end == null) continue;
    if (endsWithClosingFence(source.slice(start, end))) {
      closed.set(start, parseFenceMeta(node.meta));
    }
  }

  return closed;
}
