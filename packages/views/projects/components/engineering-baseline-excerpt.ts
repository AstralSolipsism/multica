import { stripMentionMarkdown } from "../../issues/utils/strip-mention-markdown";

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

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/==(.+?)==/g, "$1");
}

function stripLineMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]*\|?\s*$/gm, "");
}

/**
 * Turn one wiki markdown fragment into a single-line plain-text excerpt.
 * `maxLength` (UTF-16 code points, matching the old first-paragraph cap)
 * truncates with an ellipsis when given.
 */
export function plainWikiExcerpt(markdown: string, maxLength?: number): string {
  const cleaned = stripLineMarkdown(stripInlineMarkdown(stripMentionMarkdown(markdown)))
    .replace(/\[\[([^[\]\n]+)\]\]/g, (_, raw: string) => wikiLinkLabel(raw))
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength === undefined || [...cleaned].length <= maxLength) return cleaned;
  return `${Array.from(cleaned).slice(0, maxLength).join("")}…`;
}
