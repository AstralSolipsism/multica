import type { JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { mathPlaceholderPattern, mathPlaceholderPrefix } from "./math-placeholders";

export function renderInlineMath(node: JSONContent): string {
  const delimiter = node.attrs?.delimiter === "$$" ? "$$" : "$";
  return `${delimiter}${String(node.attrs?.expression ?? "")}${delimiter}`;
}

/**
 * Keep formula atoms on MarkdownManager's text path while it groups marks and
 * escapes prose. Restore raw TeX only after the complete document is rendered.
 * The copy is temporary: neither the editor document nor its marks are changed.
 */
function serializeMath(
  doc: JSONContent,
  serialize: (content: JSONContent) => string,
): string {
  const prefix = mathPlaceholderPrefix(JSON.stringify(doc));
  const formulas = new Map<string, string>();
  function asText(node: JSONContent): JSONContent {
    if (node.type === "inlineMath") {
      const marker = `${prefix}${formulas.size}$`;
      formulas.set(marker, renderInlineMath(node));
      return { type: "text", text: marker, marks: node.marks };
    }
    return node.content ? { ...node, content: node.content.map(asText) } : node;
  }
  // MarkdownManager also accepts inline arrays (e.g. clipboard slices).
  const masked = Array.isArray(doc) ? doc.map(asText) : asText(doc);
  const markdown = serialize(masked);
  return formulas.size === 0 ? markdown : markdown.replace(
    mathPlaceholderPattern(prefix), (marker) => formulas.get(marker) ?? marker,
  );
}

export const MathMarkdownExtension = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.storage.manager;
    const serialize = manager.serialize.bind(manager);
    // The parent's manager now exists, synchronously, before initial content
    // or the first getMarkdown/clipboard call. The create event is too late.
    manager.serialize = (doc) => serializeMath(doc, serialize);
  },
});
