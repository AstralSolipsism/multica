import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { WikiThreadSchema } from "@multica/core/api";
import { splitCommentSections } from "@multica/core/projects/queries";
import { renderWithI18n } from "../../test/i18n";
import { WikiMarkdown } from "./engineering-baseline-markdown";
import { WikiReadingHighlights } from "./engineering-baseline-reading-highlights";

const highlights = new Map<string, Set<Range>>();
const rectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
beforeEach(() => {
  highlights.clear();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class extends Set<Range> {
    constructor(...ranges: Range[]) { super(ranges); }
  });
  // jsdom supplies text ranges, but has no layout or CSS Highlight registry.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true, value: () => [new DOMRect(10, 20, 80, 16)],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (rectsDescriptor) Object.defineProperty(Range.prototype, "getClientRects", rectsDescriptor);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
});

const threads = [
  { id: "text", kind: "text", section: "A", exact: "needle" },
  { id: "section", kind: "section", section: "A", exact: "" },
  { id: "changed", kind: "text", section: "A", exact: "removed sentence" },
  { id: "orphaned", kind: "text", section: "Missing", exact: "deleted text" },
  { id: "resolved", kind: "text", section: "A", exact: "needle", resolved: true },
].map(({ id, kind, section, exact, resolved }) => WikiThreadSchema.parse({
  id, page_id: "page", anchor: { kind, section_anchor: section, section_title: section, exact, revision_number: 1 },
  location: { state: "anchored", section_anchor: section },
  resolved_at: resolved ? "2026-11-01T00:00:00Z" : null,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
  comments: [{ id: `${id}-comment`, author_type: "member", author_id: "me", body_markdown: "Discuss", created_at: "2026-11-01T00:00:00Z" }],
}));

function Reader({ markdown, onThread }: { markdown: string; onThread: (id: string, siblings: string[]) => void }) {
  const readerRef = useRef<HTMLDivElement>(null);
  return <div ref={readerRef}>
    {splitCommentSections(markdown).map((section) => <section key={section.anchor} data-wiki-comment-section={section.anchor} data-section-title={section.title}>
      <WikiMarkdown markdown={section.markdown} />
    </section>)}
    <WikiReadingHighlights readerRef={readerRef} threads={threads} contentKey={markdown} revisionNumber={2} activeThreadId="text" onThread={onThread} onCompose={vi.fn()} />
  </div>;
}

function highlightedText(suffix = "") {
  const entry = [...highlights].find(([key]) => suffix ? key.endsWith(suffix) : !key.endsWith("-active") && !key.endsWith("-pending"));
  expect(entry).toBeDefined();
  return [...entry![1]].map((range) => range.toString());
}

it("removes changed text markers after an edit while keeping explicit section markers", () => {
  const onThread = vi.fn();
  const { rerender } = renderWithI18n(<Reader markdown={"## A\nfirst needle"} onThread={onThread} />, { locale: "en" });
  expect(highlightedText()).toEqual(["needle", "A"]);
  expect(highlightedText("-active")).toEqual(["needle"]);
  fireEvent.click(screen.getByRole("button", { name: "Comments (2)" }));
  expect(onThread).toHaveBeenLastCalledWith("text", ["text", "section"]);

  rerender(<Reader markdown={"## A\nrewritten sentence"} onThread={onThread} />);
  expect(highlightedText()).toEqual(["A"]);
  expect(highlightedText("-active")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
  expect(onThread).toHaveBeenLastCalledWith("section", ["section"]);

  rerender(<Reader markdown={"## B\nrewritten sentence"} onThread={onThread} />);
  expect(highlightedText()).toEqual([]);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("still highlights a text anchor moved into a different section", () => {
  const onThread = vi.fn();
  renderWithI18n(<Reader markdown={"## B\nfirst needle"} onThread={onThread} />, { locale: "en" });
  expect(highlightedText()).toEqual(["needle"]);
  expect(highlightedText("-active")).toEqual(["needle"]);
  fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
  expect(onThread).toHaveBeenLastCalledWith("text", ["text"]);
});
