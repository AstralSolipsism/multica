import type { WikiCommentAnchor, WikiCommentLocation } from "../api/labrastro-baseline-comment-schemas";

export interface CommentTextSection { anchor: string; title: string; text: string }
export interface CommentMarkdownSection { anchor: string; title: string; level: number; markdown: string }

/** Mirror scanHeadings: fenced examples are inert, and own text stops at H1–H3. */
export function splitCommentSections(content: string): CommentMarkdownSection[] {
  const headings: { anchor: string; title: string; level: number; start: number }[] = [];
  const seen = new Set<string>();
  let parent = "", fence = "", offset = 0;
  for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    const line = match[0].replace(/[\r\n]+$/, "");
    const trimmed = line.replace(/^ +/, "");
    let inFence = fence !== "";
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (trimmed.startsWith(fence) && trimmed.slice(marker.length).trim() === "") fence = "";
      inFence = true;
    }
    const heading = !inFence ? /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line) : null;
    if (heading) {
      if (!headings.length && content.slice(0, offset).trim()) seen.add("_preamble");
      let title = heading[2]!.replace(/\s+/g, " ").trim();
      let key = title;
      const explicit = /^\[([\p{L}\p{N}_]+-[^\]\r\n]{1,64})\][ \t]*(.*)$/u.exec(heading[2]!.trim());
      const level = heading[1]!.length;
      if (explicit) { key = explicit[1]!; title = explicit[2]!; }
      else if (level === 3 && parent) key = `${parent} / ${key}`;
      const base = key;
      for (let n = 2; seen.has(key); n++) key = `${base} (${n})`;
      seen.add(key);
      if (level < 3) parent = key;
      headings.push({ anchor: key, title, level, start: offset });
    }
    offset += match[0].length;
  }
  const out: CommentMarkdownSection[] = [];
  const preamble = content.slice(0, headings[0]?.start ?? content.length);
  if (preamble.trim()) out.push({ anchor: "_preamble", title: "", level: 0, markdown: preamble });
  headings.forEach((h, i) => out.push({ ...h, markdown: content.slice(h.start, headings[i + 1]?.start ?? content.length) }));
  return out;
}

export const normalizeCommentText = (text: string) => text.replace(/\s+/g, " ").trim();

function occurrences(text: string, exact: string): number[] {
  const out: number[] = [];
  if (!exact) return out;
  for (let offset = 0; offset <= text.length;) {
    const at = text.indexOf(exact, offset);
    if (at < 0) break;
    out.push(at); offset = at + 1;
  }
  return out;
}

export function locateCommentQuote(text: string, anchor: WikiCommentAnchor): number | undefined {
  let best: number | undefined, score = -1, distance = Infinity;
  for (const at of occurrences(text, anchor.exact)) {
    const rank = Number(!!anchor.prefix && text.slice(0, at).endsWith(anchor.prefix)) + Number(!!anchor.suffix && text.slice(at + anchor.exact.length).startsWith(anchor.suffix));
    const delta = Math.abs(at - (anchor.start ?? 0));
    if (rank > score || (rank === score && delta < distance)) { best = at; score = rank; distance = delta; }
  }
  return best;
}

export function locateComment(sections: CommentTextSection[], anchor: WikiCommentAnchor): WikiCommentLocation {
  const original = sections.find((s) => s.anchor === anchor.sectionAnchor);
  if (original) {
    if (anchor.kind === "section") return { state: "anchored", sectionAnchor: original.anchor, start: undefined };
    const start = locateCommentQuote(original.text, anchor);
    if (start !== undefined) return { state: "anchored", sectionAnchor: original.anchor, start };
  }
  const matches: WikiCommentLocation[] = [];
  for (const section of sections) {
    if (anchor.kind === "section") {
      if (anchor.sectionTitle && section.title === anchor.sectionTitle) matches.push({ state: "moved", sectionAnchor: section.anchor, start: undefined });
    } else {
      for (const start of occurrences(section.text, anchor.exact)) matches.push({ state: "moved", sectionAnchor: section.anchor, start });
    }
  }
  if (matches.length === 1) return matches[0]!;
  return original ? { state: "section_only", sectionAnchor: original.anchor, start: undefined } : { state: "orphaned", sectionAnchor: undefined, start: undefined };
}
