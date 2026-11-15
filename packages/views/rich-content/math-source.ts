import type { Element, Root } from "hast";
import { SKIP, visit } from "unist-util-visit";

/** Keep math atomic for text selections; KaTeX's visual and MathML trees duplicate text. */
export function rehypeMathSource() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? "");
    visit(tree, "element", (node, index, parent) => {
      if (index == null || !parent) return;
      const code = node.tagName === "pre" ? node.children[0] : node;
      if (code?.type !== "element" || code.tagName !== "code") return;
      const classes = code.properties.className;
      if (!Array.isArray(classes) || !classes.includes("language-math")) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null) return;
      const raw = source.slice(start, end);
      // Fenced math already shares the code-block text contract.
      const value = /^\s*(`{3,}|~{3,})/.test(raw)
        ? code.children.map((child) => child.type === "text" ? child.value : "").join("")
        : raw;
      const wrapper: Element = {
        type: "element",
        tagName: node.tagName === "pre" ? "div" : "span",
        properties: { dataMathSource: value },
        children: [node],
      };
      parent.children[index] = wrapper;
      return SKIP;
    });
  };
}
