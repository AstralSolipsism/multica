import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { MathMarkdownExtension as Markdown } from "./math-markdown";
import { BlockMathExtension, InlineMathExtension } from "./math";
import { mathParagraphs } from "../math-fixtures";
import { createEditorExtensions } from "./index";

const FINANCE_TEXT =
  "Revenue increased from $100~$120 in Q1 to $140~$160 in Q2.";

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
}

function makeEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit,
      BlockMathExtension,
      InlineMathExtension,
      Markdown.configure({ indentation: { style: "space", size: 3 } }),
    ],
  });
}

function findAll(node: JsonNode, type: string, acc: JsonNode[] = []): JsonNode[] {
  if (node.type === type) acc.push(node);
  for (const child of node.content ?? []) findAll(child, type, acc);
  return acc;
}

function unescapeMarkdownSyntax(md: string): string {
  return md.replace(/\\([\\`*_[\]~])/g, "$1");
}

function typeText(editor: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, ch, () => editor.state.tr),
    );
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("math editor extension", () => {
  it.each(mathParagraphs)("round-trips atomic TeX in $markdown", ({ markdown, expressions }) => {
    editor = makeEditor();
    editor.commands.setContent(markdown, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression))
      .toEqual(expressions);
    expect(editor.getMarkdown()).toBe(markdown);
    editor.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression))
      .toEqual(expressions);
  });

  it.each([
    "$x$", String.raw`$8^\circ\text{C}$`, String.raw`**$< 1\sim 5\text{ms}$**`,
    "$$ x_i * y_j $$", "before $$x_i$$ after",
    "**$$ x_i * y_j $$**", "*$a_i$*", "~~$x_i$~~",
    String.raw`$\text{cost: \$5}$`,
  ])("round-trips inline delimiters and TeX in %s", (markdown) => {
    editor = makeEditor();
    editor.commands.setContent(markdown, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath")).toHaveLength(1);
    expect(findAll(editor.getJSON(), "blockMath")).toHaveLength(0);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it.each([
    "Revenue ≈ $120/mo gross (~$85 net of fees)", "$100 and $200",
    "$100~$200", "100$ and 200$", "a$x$", String.raw`\$x$`,
    "$HOME/a to /$USER/b", "$x$a", "$x$_", String.raw`$x$\alpha`,
    "$x$\\", "$ x$", "$x $", "$x\ny$", "$unclosed { brace$",
    String.raw`$\notARealTexCommand{x}$`,
    "`$x$`", "```text\n$x$\n```", "[$x$](https://example.com)",
    "[**$x$**](https://example.com)", "[$x$][ref]\n\n[ref]: https://example.com",
    "$x `code` y$", "$x [link](https://example.com) y$",
    "$x [link][ref] y$\n\n[ref]: https://example.com",
    "![alt $x$](https://example.com)",
  ])("respects boundaries and Markdown isolation in %s", (markdown) => {
    editor = makeEditor();
    editor.commands.setContent(markdown, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath")).toHaveLength(0);
  });

  it("keeps a price separate from the following TeX-command opener", () => {
    editor = makeEditor();
    editor.commands.setContent(String.raw`价格是$5，面积公式为$\pi r^2$。`, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression))
      .toEqual([String.raw`\pi r^2`]);
    expect(editor.getText()).toContain("价格是$5，面积公式为");
  });

  it("does not confuse decoded prose with temporary math tokens", () => {
    editor = makeEditor();
    editor.commands.setContent("$x$ <b>&#36;multicamath0$</b> <i>&#36;multicamathx0$</i>", { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression)).toEqual(["x"]);
    expect(editor.getText()).toBe(" $multicamath0$ $multicamathx0$");
  });

  it.each([
    ["$x$\\\n$y$", ["x", "y"]],
    ["> $x$\\\n> $y$", ["x", "y"]],
    ["- first\n  $x$", ["x"]],
    ["$x$ and `code` then $y$", ["x", "y"]],
    ["[$x$][ref] then $y$\n\n[ref]: https://example.com", ["y"]],
    ["**[$x$](https://example.com)** then $y$", ["y"]],
    ["$multicamath0$ then $x$", ["multicamath0", "x"]],
    ["**a**$x$", ["x"]],
    ["a**$x$**b", ["x"]],
  ])("keeps complete inline context for %s", (markdown, expressions) => {
    editor = makeEditor();
    editor.commands.setContent(markdown as string, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression))
      .toEqual(expressions);
  });

  it("does not convert typed formulas with input rules", () => {
    editor = makeEditor();
    typeText(editor, "$x$");
    expect(findAll(editor.getJSON(), "inlineMath")).toHaveLength(0);
    expect(editor.getText()).toBe("$x$");
  });

  it("preserves enclosing bold across text and inline atoms on repeated saves", () => {
    editor = makeEditor();
    editor.commands.setContent("**before $a_i$ after**", { contentType: "markdown" });
    for (let i = 0; i < 3; i++) {
      expect(editor.getMarkdown()).toBe("**before $a_i$ after**");
      editor.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
      expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression))
        .toEqual(["a_i"]);
      expect(editor.getText()).toBe("before  after");
    }
  });

  it.each([
    String.raw`**阈值为 $\eta_{i,a}$**`,
    "*$a_i$ and $b_j$*",
    "~~旧值 $x_1$ 已废弃~~",
    "**当 $x > 0$ 时成立**",
    "==$a_i$ and $b_j$==",
    "a ==b $x_1$== $y_2$",
    "***before $x_1$ after***",
    "$multicamath1$$x$$ tail",
    "q$$x$$",
  ])("preserves exact Markdown immediately and on repeated saves with production extensions: %s", (markdown) => {
    editor = new Editor({
      extensions: createEditorExtensions({}),
      content: markdown,
      contentType: "markdown",
    });
    for (let i = 0; i < 3; i++) {
      expect(editor.getMarkdown()).toBe(markdown);
      // Clipboard serialization uses the manager directly.
      expect(editor.markdown!.serialize(editor.getJSON())).toBe(markdown);
      editor.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
    }
  });

  it("isolates custom mention atoms from math placeholders", () => {
    const markdown = "[@a $x$ b](mention://member/1) $y$";
    editor = new Editor({ extensions: createEditorExtensions({}), content: markdown, contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath").map((node) => node.attrs?.expression)).toEqual(["y"]);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it.each(["a $$x\ny$$ b", "$$x$$$", "$$a `b$$` c"])("keeps invalid inline double dollars literal: %s", (markdown) => {
    editor = makeEditor();
    editor.commands.setContent(markdown, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "inlineMath")).toHaveLength(0);
    expect(findAll(editor.getJSON(), "blockMath")).toHaveLength(0);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it.each(["$$x\ny$$", "$$\nx\ny$$", "$$x\ny\n$$"])("requires separate delimiter lines for block math: %s", (markdown) => {
    editor = makeEditor();
    editor.commands.setContent(markdown, { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "blockMath")).toHaveLength(0);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it.each(["$x_i$", "$$ x_i $$"])("preserves delimiters through HTML copying: %s", (markdown) => {
    editor = makeEditor();
    editor.commands.setContent(markdown, { contentType: "markdown" });
    const html = editor.getHTML();
    editor.commands.setContent(html);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("keeps typed single-dollar amounts as literal text", () => {
    editor = makeEditor();

    typeText(editor, FINANCE_TEXT);

    expect(findAll(editor.getJSON() as JsonNode, "inlineMath")).toHaveLength(0);
    expect(editor.getText()).toBe(FINANCE_TEXT);
    expect(unescapeMarkdownSyntax(editor.getMarkdown().trim())).toBe(FINANCE_TEXT);
  });

  it("parses single-dollar markdown as literal text", () => {
    editor = makeEditor();

    editor.commands.setContent(FINANCE_TEXT, { contentType: "markdown" });

    expect(findAll(editor.getJSON() as JsonNode, "inlineMath")).toHaveLength(0);
    expect(editor.getText()).toBe(FINANCE_TEXT);
    expect(unescapeMarkdownSyntax(editor.getMarkdown().trim())).toBe(FINANCE_TEXT);
  });

  it("still parses explicit display math blocks", () => {
    editor = makeEditor();
    const markdown = "$$\nx^2 + y^2 = z^2\n$$";

    editor.commands.setContent(markdown, { contentType: "markdown" });

    const blocks = findAll(editor.getJSON() as JsonNode, "blockMath");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.attrs?.expression).toBe("x^2 + y^2 = z^2");
    expect(editor.getMarkdown().trim()).toBe(markdown);
  });

  it("interrupts a paragraph only at a complete display-math opener", () => {
    editor = makeEditor();
    editor.commands.setContent("before\n$$\nx^2\n$$\nafter", { contentType: "markdown" });
    expect(findAll(editor.getJSON(), "blockMath").map((node) => node.attrs?.expression)).toEqual(["x^2"]);
    expect(editor.getMarkdown()).toBe("before\n\n$$\nx^2\n$$\n\nafter");
  });
});
