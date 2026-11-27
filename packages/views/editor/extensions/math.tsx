"use client";

import katex from "katex";
import { mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { BlockMathSchema, InlineMathSchema } from "../schema/math";
import { createInlineMathTokenizer, parseInlineMath } from "./inline-math-tokenizer";
import { renderInlineMath } from "./math-markdown";

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

export const InlineMathExtension = InlineMathSchema.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
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

  parseMarkdown: parseInlineMath,

  renderMarkdown: renderInlineMath,

  addNodeView() {
    return ReactNodeViewRenderer(InlineMathView);
  },
});

export const BlockMathExtension = BlockMathSchema.extend({
  markdownTokenizer: {
    name: "blockMath",
    level: "block" as const,
    start(src: string) {
      // Marked calls start with src.slice(1). A match at offset zero may
      // actually be mid-paragraph (q$$x$$); only interrupt at a real newline.
      const match = /\n(?=\$\$[ \t]*\r?\n)/.exec(src);
      return match ? match.index + 1 : -1;
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

  addNodeView() {
    return ReactNodeViewRenderer(BlockMathView);
  },
});
