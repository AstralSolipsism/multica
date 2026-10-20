"use client";

import katex from "katex";
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { createInlineMathTokenizer, parseInlineMath } from "./inline-math-tokenizer";

function renderMath(expression: string, displayMode: boolean): string {
  return katex.renderToString(expression, {
    displayMode,
    output: "htmlAndMathml",
    strict: "warn",
    throwOnError: false,
  });
}

function InlineMathView({ node }: NodeViewProps) {
  const expression = String(node.attrs.expression ?? "");
  return (
    <NodeViewWrapper
      as="span"
      className="math-node inline"
      data-type="inline-math"
      data-expression={expression}
      data-delimiter={node.attrs.delimiter}
      contentEditable={false}
    >
      <span dangerouslySetInnerHTML={{ __html: renderMath(expression, false) }} />
    </NodeViewWrapper>
  );
}

function BlockMathView({ node }: NodeViewProps) {
  const expression = String(node.attrs.expression ?? "");
  return (
    <NodeViewWrapper
      as="div"
      className="math-node block"
      data-type="block-math"
      data-expression={expression}
      contentEditable={false}
    >
      <div dangerouslySetInnerHTML={{ __html: renderMath(expression, true) }} />
    </NodeViewWrapper>
  );
}

export const InlineMathExtension = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      expression: {
        default: "",
        rendered: false,
      },
      delimiter: {
        default: "$",
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="inline-math"]',
        getAttrs: (el) => ({
          expression: (el as HTMLElement).getAttribute("data-expression") ?? "",
          delimiter: (el as HTMLElement).getAttribute("data-delimiter") === "$$" ? "$$" : "$",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "inline-math",
        "data-expression": node.attrs.expression,
        "data-delimiter": node.attrs.delimiter,
      }),
      node.attrs.expression,
    ];
  },

  // Loading/pasting Markdown converts formulas; typing has no input rule.
  markdownTokenizer: createInlineMathTokenizer(),

  parseMarkdown: (token, helpers) => token.attributes
    ? helpers.createNode("inlineMath", token.attributes)
    : parseInlineMath(token, helpers),

  renderMarkdown: (node, helpers) => {
    const expression = String(node.attrs?.expression ?? "");
    const delimiter = node.attrs?.delimiter === "$$" ? "$$" : "$";
    const raw = `${delimiter}${expression}${delimiter}`;
    if (!node.marks?.length) return raw;
    // MarkdownManager does not wrap marks around inline atoms. Use its mark
    // serializers, substituting raw TeX only after text escaping has finished.
    const marker = "MULTICAMATH";
    return helpers.renderChildren([{ type: "text", text: marker, marks: node.marks }])
      .replace(marker, () => raw);
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineMathView);
  },
});

export const BlockMathExtension = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  code: true,
  defining: true,
  isolating: true,
  selectable: true,

  addAttributes() {
    return {
      expression: {
        default: "",
        rendered: false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="block-math"]',
        getAttrs: (el) => ({
          expression: (el as HTMLElement).getAttribute("data-expression") ?? "",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "block-math",
        "data-expression": node.attrs.expression,
      }),
      node.attrs.expression,
    ];
  },

  markdownTokenizer: {
    name: "blockMath",
    level: "block" as const,
    start(src: string) {
      return src.search(/^\$\$/m);
    },
    tokenize(src: string) {
      if (!src.startsWith("$$")) return undefined;
      const match = src.match(/^\$\$[ \t]*\r?\n([\s\S]+?)\r?\n\$\$(?:\r?\n|$)/);
      if (!match) return undefined;
      return {
        type: "blockMath",
        raw: match[0],
        attributes: { expression: match[1] ?? "" },
      };
    },
  },

  parseMarkdown: (token: any, helpers: any) => {
    return helpers.createNode("blockMath", token.attributes);
  },

  renderMarkdown: (node: any) => {
    const expression = String(node.attrs?.expression ?? "");
    return `$$\n${expression}\n$$`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockMathView);
  },
});
