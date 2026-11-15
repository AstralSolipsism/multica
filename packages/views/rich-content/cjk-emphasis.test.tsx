import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkRepairCjkStrongTrailingWhitespace } from "./cjk-emphasis";

/** Render through the plugin alone (no remarkCjkFriendly) so every case is a
 * literal `**` span in the AST — exactly what the repair must recover. */
function renderMarkdown(markdown: string) {
  const { container } = render(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkRepairCjkStrongTrailingWhitespace]}>
      {markdown}
    </ReactMarkdown>,
  );
  return {
    text: container.textContent ?? "",
    strongs: Array.from(container.querySelectorAll("strong"), (el) => el.textContent ?? ""),
  };
}

describe("remarkRepairCjkStrongTrailingWhitespace", () => {
  it("repairs CJK punctuation glued to the delimiters (OL-1373 repro)", () => {
    const { text, strongs } = renderMarkdown(
      "采用**「家庭局域网 → 海外高速专线中继 → 美国固定家宽出口」**的架构",
    );
    expect(strongs).toEqual(["「家庭局域网 → 海外高速专线中继 → 美国固定家宽出口」"]);
    expect(text).not.toContain("**");
  });

  it("repairs trailing whitespace inside the span and keeps it outside the strong", () => {
    const { text, strongs } = renderMarkdown("首先**中文。 **后续文本");
    expect(strongs).toEqual(["中文。"]);
    expect(text).toBe("首先中文。 后续文本");
  });

  it("repairs leading whitespace inside the span (mirrored form)", () => {
    const { text, strongs } = renderMarkdown("首先** 中文。**后续文本");
    expect(strongs).toEqual(["中文。"]);
    expect(text).toBe("首先 中文。后续文本");
  });

  it.each(["说明 ** 中文 ** 结束", "text ** 中文** end", "text **\t中文\t** end"])("repairs isolated inner whitespace: %s", (source) => {
    const { text, strongs } = renderMarkdown(source);
    expect(strongs).toEqual(["中文"]);
    expect(text).toBe(source.replaceAll("**", ""));
  });

  it("preserves escaped markers and code containing CJK whitespace", () => {
    const { text, strongs } = renderMarkdown("采用\\*\\*「家庭」\\*\\*的架构和 `** 中文 **`");
    expect(strongs).toEqual([]);
    expect(text).toContain("采用**「家庭」**的架构");
    expect(text).toContain("** 中文 **");
  });

  it("repairs a closer glued to a following CJK letter", () => {
    const { text, strongs } = renderMarkdown("text **加粗**的结尾");
    expect(strongs).toEqual(["加粗"]);
    expect(text).not.toContain("**");
  });

  it("repairs an opener glued to a preceding CJK letter even for ASCII inner text", () => {
    const { text } = renderMarkdown("采用**bold**方案");
    expect(text).not.toContain("**");
  });


  it("keeps valid emphasis and deliberately literal runs untouched", () => {
    // Intraword `**` is VALID CommonMark — not something the repair invented.
    const intraword = renderMarkdown("foo**bar**baz");
    expect(intraword.strongs).toEqual(["bar"]);
    expect(intraword.text).not.toContain("**");

    // A literal run without CJK adjacency stays literal — the repair is
    // deliberately narrow (the closer is preceded by a space, so remark left
    // it, but nothing marks it as broken CJK emphasis).
    const literal = renderMarkdown("foo **bar **baz");
    expect(literal.strongs).toEqual([]);
    expect(literal.text).toContain("foo **bar **baz");

    // Inline code keeps its markers.
    const code = renderMarkdown("run `**not emphasis**` now");
    expect(code.strongs).toEqual([]);
  });

  it("repairs several spans in one paragraph independently", () => {
    const { text, strongs } = renderMarkdown("x **中文A。 ** y **中文B。 ** z");
    expect(strongs).toEqual(["中文A。", "中文B。"]);
    expect(text).not.toContain("**");
  });
});
