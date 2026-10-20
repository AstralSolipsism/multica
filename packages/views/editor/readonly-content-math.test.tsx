import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@multica/ui/markdown";
import { ReadonlyContent } from "./readonly-content";
import { RichContent } from "../rich-content";
import { mathParagraphs } from "./math-fixtures";

const renderers = {
  Markdown: (content: string) => <Markdown>{content}</Markdown>,
  ReadonlyContent: (content: string) => <ReadonlyContent content={content} />,
  RichContent: (content: string) => (
    <RichContent content={content} density="compact" phase="streaming" />
  ),
};

it.each(["**中文。 **后文 $x$", "$x$ **中文。 **后文"])("preserves CJK emphasis beside math in %s", (content) => {
  const { container } = render(
    <ReadonlyContent content={content} />,
  );
  expect(container.querySelectorAll(".katex")).toHaveLength(1);
  expect(Array.from(container.querySelectorAll("strong"), (node) => node.textContent))
    .toEqual(["中文。"]);
});

for (const [name, renderContent] of Object.entries(renderers)) {
  describe(`${name} math`, () => {
    it.each(mathParagraphs)("keeps TeX atomic in $markdown", ({ markdown, expressions, prose }) => {
      const { container } = render(renderContent(markdown));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(expressions);
      expect(container.querySelector("em, .katex-error")).toBeNull();
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe(prose);
    });

    it("retains bold around a formula containing punctuation", () => {
      const { container } = render(renderContent(String.raw`**$< 1\sim 5\text{ms}$**`));
      expect(container.querySelectorAll("strong .katex")).toHaveLength(1);
    });

    it("does not let a formula cross a table-cell boundary", () => {
      const { container } = render(renderContent("| a | b |\n| - | - |\n| $x | y$ |"));
      expect(container.querySelectorAll("td")).toHaveLength(2);
      expect(container.querySelector(".katex")).toBeNull();
    });

    it.each([
      [String.raw`热量范围在 $0 \sim 10000\text{ kcal}$ 之间`, String.raw`0 \sim 10000\text{ kcal}`],
      ["根据公式 $E = mc^2$，可知", "E = mc^2"],
      ["Formula: ($a + b = c$).", "a + b = c"],
      ["$x$", "x"],
      ["变量$x$为正", "x"],
      ["When $x > 0$, continue.", "x > 0"],
      [String.raw`集合 $\{x\}$。`, String.raw`\{x\}`],
      [String.raw`$\frac{a}{b}$`, String.raw`\frac{a}{b}`],
      [String.raw`$x_{i} + y_{j}$`, String.raw`x_{i} + y_{j}`],
      [String.raw`$\begin{matrix}a&b\\c&d\end{matrix}$`, String.raw`\begin{matrix}a&b\\c&d\end{matrix}`],
      [String.raw`$\text{cost: \$5}$`, String.raw`\text{cost: \$5}`],
      [String.raw`$速度=\frac{路程}{时间}$`, String.raw`速度=\frac{路程}{时间}`],
      ["**$x$**", "x"],
      ["> first line\n> $x$", "x"],
      ["- first line\n  $x$", "x"],
      ["&amp; $x$", "x"],
      ["$x$ &amp; tail", "x"],
      [String.raw`\$100 and $x$`, "x"],
      ["$100 and $x$", "x"],
    ])("renders single-dollar math in %s", (content, expression) => {
      const { container } = render(renderContent(content));
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(container.querySelector('annotation[encoding="application/x-tex"]')?.textContent)
        .toBe(expression);
      expect(container.querySelector(".katex-error")).toBeNull();
    });

    it.each([
      "Revenue ≈ $120/mo gross (~$85 net of fees), 12 active subscriptions",
      "$100 and $200",
      "$100~$200",
      "$100-$200",
      "100$ and 200$",
      "套餐 A $100，套餐 B $200",
      "$HOME/a to /$USER/b",
      "$unclosed { brace$",
      String.raw`$\notARealTexCommand{x}$`,
      "$ x$",
      "$\tx$",
      "$x $",
      "$x\t$",
      "a$x$",
      "0$x$",
      "$x$a",
      "$x$0",
      "$x$_",
      String.raw`$x$\alpha`,
      "$x$\\",
    ])("keeps literal text in %s", (content) => {
      const { container } = render(renderContent(content));
      expect(container.querySelector(".katex, .katex-error")).toBeNull();
      expect(container.textContent).toBe(content);
    });

    it.each(["\n", "\r\n", "\r", "\n\n"])("does not cross a %j line break", (newline) => {
      const { container } = render(renderContent(`$x${newline}y$`));
      expect(container.querySelector(".katex, .katex-error")).toBeNull();
      expect(container.textContent).toBe("$x\ny$");
    });

    it.each([
      ["bold", "a $x$ **b**", "x", "a  b"],
      ["inline code", "$x$ `code`", "x", " code"],
      ["link", "根据 $E=mc^2$ [参考](https://example.com)", "E=mc^2", "根据  参考"],
    ])("preserves text-node trailing spaces before %s", (_kind, content, expression, prose) => {
      const { container } = render(renderContent(content));
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(container.querySelector("annotation")?.textContent).toBe(expression);
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe(prose);
    });

    it.each(["\u3000", "\u00a0"])("preserves Unicode whitespace %j before a line ending", (trailing) => {
      const { container } = render(renderContent(`第一行 $x$${trailing}\n第二行 $y$`));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(["x", "y"]);
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe(`第一行 ${trailing}\n第二行 `);
    });

    describe.each(["\n", "\r\n", "\r"])("backslash hard breaks with %j", (newline) => {
      it.each([
        [`$x$\\${newline}$y$`, ["x", "y"]],
        [`公式 $E=mc^2$\\${newline}下一行`, ["E=mc^2"]],
        [`> $x$\\${newline}> b`, ["x"]],
      ] as const)("renders math immediately before the break in %s", (content, expressions) => {
        const { container } = render(renderContent(content));
        expect(container.querySelectorAll(".katex")).toHaveLength(expressions.length);
        expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
          .toEqual(expressions);
        expect(container.querySelectorAll("br")).toHaveLength(1);
        expect(container.querySelector(".katex-error")).toBeNull();
      });
    });

    it("does not treat an escaped backslash as a hard-break exception", () => {
      const { container } = render(renderContent("$x$\\\\\n$y$"));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(["y"]);
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe("$x$\\\n");
    });

    describe.each([" ", "\t"])("trailing line whitespace %j", (trailing) => {
      it.each([
        ["paragraph", `第一行 $x$${trailing}\n第二行 $y$`, ["x", "y"], "第一行 \n第二行"],
        ["after bold", `**粗体** $x$${trailing}\n下一行`, ["x"], "粗体 \n下一行"],
        ["quote", `> $x$${trailing}\n> b`, ["x"], "b"],
        ["list", `- $x$${trailing}\n  b`, ["x"], "b"],
        ["quote continuation", `> a\n> $x$${trailing}\n> $y$ b`, ["x", "y"], "a\n\n b"],
        ["decoded entities", `&amp; $x$ &amp;${trailing}\n$y$ b`, ["x", "y"], "&  &\n b"],
      ] as const)("renders formulas in a %s", (_context, content, expressions, prose) => {
        const { container } = render(renderContent(content));
        expect(container.querySelectorAll(".katex")).toHaveLength(expressions.length);
        expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
          .toEqual(expressions);
        expect(container.querySelector(".katex-error")).toBeNull();
        container.querySelectorAll(".katex").forEach((node) => node.remove());
        expect(container.textContent?.trim()).toBe(prose);
      });
    });

    it.each(["\r\n", "\r"])("aligns trimmed text before a %j line ending", (newline) => {
      const { container } = render(renderContent(`$x$ \t${newline}$y$`));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(["x", "y"]);
    });

    it("preserves character-reference whitespace before a line ending", () => {
      const { container } = render(renderContent("&amp; $x$&#32;\n$y$ b"));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(["x", "y"]);
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe("&  \n b");
    });

    it.each([
      [String.raw`\$x$`, "$x$"],
      [String.raw`$x\$`, "$x$"],
      ["&#36;x$", "$x$"],
      ["$x&#36;", "$x$"],
      ["`$0 \\sim 10000$`", String.raw`$0 \sim 10000$`],
      ["```text\n$x$\n```", "$x$"],
      ["[$x$](https://example.com)", "$x$"],
      ["[$x$][ref]\n\n[ref]: https://example.com", "$x$"],
      ["[**$x$**](https://example.com)", "$x$"],
      ["$x `code` y$", "$x code y$"],
      ["$x [link](https://example.com) y$", "$x link y$"],
    ])("respects Markdown isolation in %s", (content, visibleText) => {
      const { container } = render(renderContent(content));
      expect(container.querySelector(".katex, .katex-error")).toBeNull();
      expect(container.textContent).toContain(visibleText);
    });

    it.each([
      ["$$E = mc^2$$", false],
      ["$$\nE = mc^2\n$$", true],
    ])("preserves double-dollar math in %s", (content, display) => {
      const { container } = render(renderContent(content));
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(Boolean(container.querySelector(".katex-display"))).toBe(display);
    });

    it("renders successive formulas without consuming surrounding prose", () => {
      const { container } = render(renderContent("$x$，$y$; $bad {$ then $z$."));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(["x", "y", "z"]);
      expect(container.textContent).toContain("; $bad {$ then ");
      expect(container.textContent).toContain("，");
      expect(container.textContent).toMatch(/\.$/);
    });

    it.each([
      [String.raw`价格是$5，面积公式为$\pi r^2$。`, String.raw`\pi r^2`, "价格是$5，面积公式为。"],
      [String.raw`前文 $HOME/a，然后计算$\sqrt{2}$`, String.raw`\sqrt{2}`, "前文 $HOME/a，然后计算"],
      [String.raw`售价 $20（含税），面积：$\frac{1}{2}ab$`, String.raw`\frac{1}{2}ab`, "售价 $20（含税），面积："],
      [String.raw`Pay $5, then compute:$\frac{a}{b}$.`, String.raw`\frac{a}{b}`, "Pay $5, then compute:."],
    ])("keeps a TeX-command opener separate from preceding prose in %s", (content, expression, prose) => {
      const { container } = render(renderContent(content));
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(container.querySelector("annotation")?.textContent).toBe(expression);
      expect(container.querySelector(".katex-error")).toBeNull();
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe(prose);
    });

    // OL-911: the accepted backslash boundary does not disambiguate openers
    // beginning with '-' or '('. Such prose is valid TeX; retain this known
    // limitation rather than introducing formula-content heuristics.
    it.each([
      [String.raw`成本 $5，增长$-3\%$`, "5，增长", "成本 -3%$"],
      ["Pay $5, then compute:$(a+b)^2$.", "5, then compute:", "Pay (a+b)^2$."],
    ])("documents the remaining delimiter ambiguity in %s", (content, expression, prose) => {
      const { container } = render(renderContent(content));
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(container.querySelector("annotation")?.textContent).toBe(expression);
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent).toBe(prose);
    });

    it("preserves decoded text and container prefixes around formulas", () => {
      const { container } = render(renderContent("> &amp; $x$ &amp; $y$\n> $z$ tail"));
      expect(Array.from(container.querySelectorAll("annotation"), (node) => node.textContent))
        .toEqual(["x", "y", "z"]);
      expect(container.querySelector("blockquote")).not.toBeNull();
      // Remove only the rendered math to inspect the untouched prose.
      container.querySelectorAll(".katex").forEach((node) => node.remove());
      expect(container.textContent?.trim()).toBe("&  & \n tail");
    });
  });
}
