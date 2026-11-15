import { stripMentionMarkdown } from "../../issues/utils/strip-mention-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { remarkRepairCjkStrongTrailingWhitespace } from "../../rich-content/cjk-emphasis";

/**
 * Plain-text excerpts for wiki surfaces (OL-1373): hover-preview snippets,
 * backlink rows, search results and comment-list fallbacks all show the same
 * cleaned text — no `mention://` protocol source, no `[[wiki link]]` brackets,
 * no bare Markdown control characters.
 *
 * `stripMentionMarkdown` (the chat/comment summary path) handles mention
 * links; this adds the wiki grammar and a Markdown-symbol scrub on top so
 * every surface shares one definition of "readable summary".
 */

/** `[[target]]`, `[[target#section]]`, `[[target#section|display]]` → the
 * text the chip itself would show (display wins, `target › section` falls
 * back), mirroring the chip label in engineering-baseline-markdown. */
export function wikiLinkLabel(raw: string): string {
  const [targetWithSection = "", label] = raw.split("|");
  const display = label?.trim();
  if (display) return display;
  const hash = targetWithSection.indexOf("#");
  if (hash === -1) return targetWithSection.trim();
  return `${targetWithSection.slice(0, hash).trim()} › ${targetWithSection.slice(hash + 1).trim()}`;
}

function excerptText(node: Nodes): string {
  if (node.type === "html" || node.type === "definition") return "";
  if (node.type === "image") return node.alt ?? "";
  if ("value" in node) return node.value;
  if ("children" in node) {
    const text = node.children.map(excerptText).join("");
    return ["paragraph", "heading", "listItem", "blockquote"].includes(node.type) ? `${text} ` : text;
  }
  return node.type === "break" ? " " : "";
}

/**
 * Turn one wiki markdown fragment into a single-line plain-text excerpt.
 * `maxLength` counts Unicode code points (including emoji as one character) and
 * truncates with an ellipsis when given.
 */
export function plainWikiExcerpt(markdown: string, maxLength?: number): string {
  const source = stripMentionMarkdown(markdown)
    .replace(/\[\[([^[\]\n]+)\]\]/g, (_, raw: string) => wikiLinkLabel(raw))
    // Search/backlink windows may cut either end of a Markdown link.
    .replace(/\[([^\]\n]*)\]\(mention:\/\/[^)\s]*\)?/gi, "$1")
    .replace(/\]?\(?mention:\/\/[^)\s]*\)?/gi, "")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/==(.+?)==/g, "$1")
    .replace(/^\s*\|?[\s:|-]*\|?\s*$/gm, "")
    .replace(/\|/g, " ");
  const tree = fromMarkdown(source);
  remarkRepairCjkStrongTrailingWhitespace()(tree, { value: source });
  const cleaned = excerptText(tree)
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength === undefined || [...cleaned].length <= maxLength) return cleaned;
  return `${Array.from(cleaned).slice(0, maxLength).join("")}…`;
}
