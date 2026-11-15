import type { PhrasingContent, Root, Strong, Text } from "mdast";
import { visit } from "unist-util-visit";

// CJK script LETTERS (Han / Hiragana / Katakana / Hangul). CJK punctuation
// (「」。，) is Script=Common, so it never matches — that asymmetry is what
// breaks CommonMark emphasis around CJK prose in the first place.
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function text(value: string): Text {
  return { type: "text", value };
}

function strong(value: string): Strong {
  return { type: "strong", children: [text(value)] };
}

/** One repaired span: `**inner**` → strong(inner) plus the whitespace that
 * CommonMark would have excluded from the emphasis either way. */
interface Repair {
  /** Inner text that becomes the <strong> content. */
  emphasized: string;
  /** Text kept OUTSIDE the strong (leading or trailing whitespace). */
  leading: string;
  trailing: string;
}

/**
 * Decide whether a literal `**inner**` run inside one text node is a broken
 * CJK-emphasis span, and how to repair it. All rules REQUIRE the inner run to
 * stay inside this text node (no scanning across other delimiters) and to
 * contain CJK script or a CJK-adjacent delimiter.
 *
 *   (a1) `**中文。 **` — a closer preceded by whitespace can never close, so
 *        the pair stays literal whatever follows it.
 *   (a2) `** 中文。**` — the mirrored form: an opener followed by whitespace
 *        can never open.
 *   (b1) `采用**「…」**的` — the opener is preceded by a CJK letter and
 *        followed by CJK punctuation, so it is not left-flanking and cannot
 *        open. (The OL-1373 wiki repro.)
 *   (b2) `**加粗**的` — the closer is followed by a CJK letter, the
 *        CJK-adjacent form most AI-authored text produces.
 *
 * Text-wise every rule is equivalent to deleting the two `**` runs; the server
 * mirrors this exact predicate set in `renderedCommentText` so the two text
 * indexes stay byte-identical (see server/internal/engineering/comment_text.go).
 */
function repairSpan(
  value: string,
  opening: number,
  closing: number,
): Repair | null {
  const inner = value.slice(opening + 2, closing);
  if (!inner || inner.includes("**")) return null;
  const first = inner[0]!;
  const last = inner[inner.length - 1]!;
  const before = opening > 0 ? value[opening - 1] : undefined;
  const after = closing + 2 < value.length ? value[closing + 2] : undefined;
  const cjkInside = CJK_SCRIPT.test(inner) && /\S/u.test(inner);

  const innerWs = (char: string | undefined) => char === " " || char === "\t";
  const repaired =
    // (a1) trailing whitespace inside: a closer preceded by whitespace can
    // never close, whatever follows the span.
    (cjkInside && !innerWs(first) && innerWs(last)) ||
    // (a2) leading whitespace inside: the opener can never open.
    (cjkInside && innerWs(first) && !innerWs(last)) ||
    // (b1) CJK letter glued before the opener: the run cannot open.
    (before !== undefined && CJK_SCRIPT.test(before) && /\S/u.test(inner)) ||
    // (b2) CJK letter glued after the closer: the run cannot close.
    (after !== undefined && CJK_SCRIPT.test(after) && /\S/u.test(inner));
  if (!repaired) return null;

  // Whitespace inside the span stays OUTSIDE the <strong>, exactly where a
  // correctly-authored span would have put it.
  let start = 0;
  let end = inner.length;
  while (start < end && innerWs(inner[start])) start++;
  while (end > start && innerWs(inner[end - 1]!)) end--;
  return { emphasized: inner.slice(start, end), leading: inner.slice(0, start), trailing: inner.slice(end) };
}

function repairTextValue(value: string): PhrasingContent[] | null {
  const replacement: PhrasingContent[] = [];
  let consumed = 0;
  let cursor = 0;

  while (cursor < value.length - 1) {
    const opening = value.indexOf("**", cursor);
    if (opening === -1) break;

    const firstInner = value[opening + 2];
    if (firstInner == null || firstInner === "*") {
      cursor = opening + 2;
      continue;
    }

    // Do not look across another delimiter run: that would reinterpret valid
    // or deliberately literal Markdown beyond the one malformed span.
    const closing = value.indexOf("**", opening + 2);
    if (closing === -1) break;

    const repair = repairSpan(value, opening, closing);
    if (!repair) {
      cursor = opening + 2;
      continue;
    }

    if (opening > consumed) replacement.push(text(value.slice(consumed, opening)));
    if (repair.leading) replacement.push(text(repair.leading));
    replacement.push(strong(repair.emphasized));
    if (repair.trailing) replacement.push(text(repair.trailing));
    consumed = closing + 2;
    cursor = consumed;
  }

  if (replacement.length === 0) return null;
  if (consumed < value.length) replacement.push(text(value.slice(consumed)));
  return replacement;
}

/**
 * Recover the common AI-authored forms that CommonMark leaves as literal
 * `**` because of CJK adjacency or intra-span whitespace:
 * `**中文。 **next`, `** 中文。**`, `采用**「…」**的`, `**加粗**的`.
 *
 * This transformer is deliberately narrower than a raw string rewrite. It
 * only visits parsed text nodes whose source slice still equals their value,
 * so code, valid Markdown nodes, escaped Markdown and non-CJK prose keep
 * their original semantics. The same predicate set is mirrored server-side
 * (comment_text.go) — keep both in sync when touching this file.
 */
export function remarkRepairCjkStrongTrailingWhitespace() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? "");

    visit(tree, "text", (node, index, parent) => {
      if (index == null || parent == null || parent.type === "strong") return;

      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null || source.slice(start, end) !== node.value) {
        return;
      }

      const replacement = repairTextValue(node.value);
      if (!replacement) return;
      parent.children.splice(index, 1, ...replacement);
    });
  };
}
