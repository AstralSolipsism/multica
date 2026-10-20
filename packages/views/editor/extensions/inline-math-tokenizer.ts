import type { JSONContent, MarkdownParseHelpers, MarkdownToken, MarkdownTokenizer } from "@tiptap/core";
import { decodeString } from "micromark-util-decode-string";
import { findInlineMath, type SourceRange } from "@multica/ui/markdown/inline-math";
import { mathPlaceholderPattern, mathPlaceholderPrefix } from "./math-placeholders";

const isolated = new Set(["codespan", "code", "link", "image", "html"]);

function isolatedRanges(tokens: MarkdownToken[], source: string, offset = 0): SourceRange[] {
  const ranges: SourceRange[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const raw = token.raw ?? "";
    const start = source.indexOf(raw, cursor);
    if (start < 0) continue;
    const end = start + raw.length;
    // Custom atoms (mentions, slash-command links, etc.) carry attributes.
    if (isolated.has(token.type ?? "") || token.attributes) {
      ranges.push({ start: offset + start, end: offset + end });
    } else if (token.tokens?.length) {
      // Marked preserves raw source on nested emphasis/highlight tokens.
      ranges.push(...isolatedRanges(token.tokens, raw, offset + start));
    }
    cursor = end;
  }
  return ranges;
}

/**
 * Inspect each complete inline scope once, before Marked consumes its prefix.
 * This preserves the left boundary even when tokenize later receives slices.
 *
 * A normal Marked pass identifies code and links using the active lexer's
 * reference definitions. A second pass protects validated TeX with temporary,
 * collision-free dollar tokens. Marked can then pair surrounding emphasis
 * without ever seeing TeX's underscores/stars. Only real math nodes, with the
 * original TeX and delimiter, leave this tokenizer; no sentinels are persisted.
 */
export function createInlineMathTokenizer(): MarkdownTokenizer {
  const scanned = new WeakSet<MarkdownToken[]>();
  let mode: "baseline" | "protected" | undefined;
  let prefix = "";
  let protectedTokens = new Map<string, MarkdownToken>();

  return {
    name: "inlineMath",
    level: "inline",
    start(source) {
      return mode === "protected" ? source.indexOf(prefix) : -1;
    },
    tokenize(source, tokens, helpers) {
      if (mode === "baseline") return;
      if (mode === "protected") {
        if (!source.startsWith(prefix)) return;
        const end = source.indexOf("$", prefix.length);
        return protectedTokens.get(source.slice(0, end + 1));
      }
      if (scanned.has(tokens)) return;
      scanned.add(tokens);
      if (!source.includes("$")) return;

      try {
        mode = "baseline";
        const baseline = helpers.inlineTokens(source);
        const matches = findInlineMath(source, isolatedRanges(baseline, source), true);
        // Return the already-tokenized scope even without math. Otherwise
        // Marked would tokenize link labels again outside the isolation pass.
        if (matches.length === 0) return { type: "inlineMath", raw: source, tokens: baseline };

        prefix = mathPlaceholderPrefix(source + decodeString(source));
        protectedTokens = new Map();
        let masked = "";
        let cursor = 0;
        for (const [index, match] of matches.entries()) {
          const marker = `${prefix}${index}$`;
          masked += source.slice(cursor, match.start) + marker;
          protectedTokens.set(marker, {
            type: "inlineMath",
            raw: marker,
            attributes: { expression: match.expression, delimiter: match.delimiter },
          });
          cursor = match.end;
        }
        masked += source.slice(cursor);
        mode = "protected";
        return {
          type: "inlineMath",
          raw: source,
          tokens: helpers.inlineTokens(masked),
          mathPrefix: prefix,
        };
      } finally {
        mode = undefined;
        protectedTokens = new Map();
      }
    },
  };
}

export function parseInlineMath(token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent[] {
  const atoms = new Map<string, MarkdownToken>();
  function asText(tokens: MarkdownToken[]): MarkdownToken[] {
    return tokens.map((child) => {
      if (child.type === "inlineMath" && child.attributes) {
        const marker = child.raw!;
        atoms.set(marker, child);
        return { type: "text", raw: marker, text: marker };
      }
      return child.tokens ? { ...child, tokens: asText(child.tokens) } : child;
    });
  }
  // Tiptap's Markdown applyMark only marks text, not inline atoms. Let it
  // resolve all enclosing marks on temporary text, then restore the atoms.
  const content = helpers.parseInline(asText(token.tokens ?? []));
  if (atoms.size === 0) return content;
  return content.flatMap((node) => {
    if (node.type !== "text" || !node.text) return [node];
    const result: JSONContent[] = [];
    let cursor = 0;
    // These are generated token ids, never a heuristic for formula contents.
    for (const match of node.text.matchAll(mathPlaceholderPattern(token.mathPrefix as string))) {
      const atom = atoms.get(match[0]);
      if (!atom) continue;
      if (match.index > cursor) result.push({ ...node, text: node.text.slice(cursor, match.index) });
      result.push({
        ...helpers.createNode("inlineMath", atom.attributes),
        marks: node.marks,
      });
      cursor = match.index + match[0].length;
    }
    if (cursor < node.text.length) result.push({ ...node, text: node.text.slice(cursor) });
    return result;
  });
}
