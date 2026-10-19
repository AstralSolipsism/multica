import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@multica/ui/markdown";
import { ReadonlyContent } from "./readonly-content";
import { RichContent } from "../rich-content";

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
