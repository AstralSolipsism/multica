import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { WikiCommentAnchorSchema, WikiCommentLocationSchema } from "@multica/core/api";
import { locateComment, splitCommentSections } from "@multica/core/projects/queries";
import fixtures from "../../../../server/internal/engineering/testdata/anchors.json";
import { WikiMarkdown } from "./engineering-baseline-markdown";
import { indexWikiCommentText, wikiSelectionAnchor } from "./engineering-baseline-comment-text";
import { renderWithI18n } from "../../test/i18n";

// Keep real Markdown and code chrome; diagram rendering is unrelated here.
vi.mock("../../rich-content/rich-code-block", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rich-content/rich-code-block")>();
  return { ...actual, RichFenceBlock: ({ body }: { body: string }) => <pre><code>{body}</code></pre> };
});

describe("shared anchors.json: real WikiMarkdown DOM", () => {
  for (const fixture of fixtures) it(fixture.name, () => {
    const segments = splitCommentSections(fixture.markdown);
    const links = [
      { raw: "target|Target", display: "Target", target: "target", section: "" },
      { raw: "target#Part|T", display: "T", target: "target", section: "Part" },
    ].map((l) => ({ ...l, kind: "page" as const, state: "resolved" as const, targetSlug: "target", sectionAnchor: l.section || null, candidates: [] }));
    const meta = new Map([["target", { title: "Preview noise", path: "Path noise", snippet: "Snippet noise", version: 99, updatedAt: "Yesterday" }]]);
    const { container, unmount } = renderWithI18n(<>{segments.map((s) => <div key={s.anchor} data-wiki-comment-section={s.anchor}><WikiMarkdown markdown={s.markdown} links={links} pageMeta={meta} /></div>)}</>);
    const sections = [...container.querySelectorAll<HTMLElement>("[data-wiki-markdown]")].map((el, i) => ({ ...segments[i]!, ...indexWikiCommentText(el) }));
    expect(sections.map(({ anchor, title, text }) => ({ anchor, title, text }))).toEqual(fixture.texts);
    expect(locateComment(sections, WikiCommentAnchorSchema.parse(fixture.selector))).toEqual(WikiCommentLocationSchema.parse(fixture.expected));
    for (const section of sections) {
      if (section.text) expect(section.range(0, section.text.length)).not.toBeNull();
    }
    unmount();
  });
});

it("truncates a cross-section selection and excludes UI controls", () => {
  const { container } = render(<div><section data-wiki-comment-section="A" data-section-title="A"><div data-wiki-markdown><h2>A</h2><p>first sentence</p></div><button>Edit section</button></section><section data-wiki-comment-section="B"><div data-wiki-markdown><h2>B</h2><p>second sentence</p></div></section></div>);
  const paragraphs = container.querySelectorAll("p");
  const range = document.createRange(); range.setStart(paragraphs[0]!.firstChild!, 0); range.setEnd(paragraphs[1]!.firstChild!, 6);
  const selection = window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  const result = wikiSelectionAnchor(container, selection, 3);
  expect(result?.anchor.exact).toBe("first sentence");
  expect(result?.anchor.sectionAnchor).toBe("A");
  selection.removeAllRanges();
});

it("keeps an exact end offset and UTF-16 offsets through inline markup", () => {
  const { container } = render(<section data-wiki-comment-section="A"><div data-wiki-markdown><p>😀 lead <strong>needle</strong> trailing</p></div></section>);
  const word = container.querySelector("strong")!.firstChild!;
  const range = document.createRange(); range.setStart(word, 0); range.setEnd(word, 4);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(wikiSelectionAnchor(container, selection, 1)?.anchor).toMatchObject({ exact: "need", start: 8, prefix: "😀 lead ", suffix: "le trailing" });
  selection.removeAllRanges();
});
