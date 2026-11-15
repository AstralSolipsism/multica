import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance, WikiCommentAnchorSchema, WikiCommentLocationSchema } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { issueKeys } from "@multica/core/issues/queries";
import { locateComment, splitCommentSections } from "@multica/core/projects/queries";
import fixtures from "../../../../server/internal/engineering/testdata/anchors.json";
import { WikiMarkdown } from "./engineering-baseline-markdown";
import { indexWikiCommentText, wikiSelectionAnchor } from "./engineering-baseline-comment-text";
import { IssueChip } from "../../issues/components/issue-chip";
import { renderWithI18n } from "../../test/i18n";

const WS = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "99999999-9999-4999-8999-999999999999";

const ISSUE = { id: ISSUE_ID, identifier: "OL-9", title: "噪音标题不进索引", status: "todo", status_category: "unstarted" };

setApiInstance({ getIssue: async () => ISSUE } as unknown as ApiClient);

// Keep real Markdown and code chrome; diagram rendering is unrelated here.
vi.mock("../../rich-content/rich-code-block", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rich-content/rich-code-block")>();
  return { ...actual, RichFenceBlock: ({ body }: { body: string }) => <pre><code>{body}</code></pre> };
});
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => WS }));
// OL-9 resolves to a real issue so the fixture exercises the RESOLVED chip
// (identifier text + [data-issue-chip-title] noise), not just the plain-text
// fallback.
vi.mock("../../issues/hooks", () => ({
  useResolveIssueIdentifier: (identifier: string) =>
    identifier === "OL-9"
      ? { id: ISSUE_ID, identifier: "OL-9", title: "噪音标题不进索引", status: "todo", status_category: "unstarted" }
      : null,
}));
// The card shell (AppLink + hover/menu) needs router contexts the anchor
// harness does not provide; the chip itself is the text-index surface.
vi.mock("../../issues/components/issue-mention-card", () => ({
  IssueMentionCard: ({ issueId, fallbackLabel }: { issueId: string; fallbackLabel?: string }) => (
    <IssueChip issueId={issueId} fallbackLabel={fallbackLabel} />
  ),
}));

type Fixture = (typeof fixtures)[number] & { links?: { raw: string; display: string; target: string; section?: string; state?: string; target_slug?: string | null }[] };

describe("shared anchors.json: real WikiMarkdown DOM", () => {
  for (const fixture of fixtures as Fixture[]) it(fixture.name, () => {
    const segments = splitCommentSections(fixture.markdown);
    const rawLinks: { raw: string; display: string; target: string; section?: string; target_slug?: string | null }[] = fixture.links ?? [
      { raw: "target|Target", display: "Target", target: "target", section: "" },
      { raw: "target#Part|T", display: "T", target: "target", section: "Part" },
    ];
    const links = rawLinks.map((l) => ({ raw: l.raw, display: l.display, target: l.target, section: l.section ?? "", kind: "page" as const, state: "resolved" as const, targetSlug: l.target_slug ?? "target", sectionAnchor: l.section || null, candidates: [] }));
    const meta = new Map([["target", { title: "Preview noise", path: "Path noise", snippet: "Snippet noise", version: 99, updatedAt: "Yesterday" }]]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(issueKeys.detail(WS, ISSUE_ID), ISSUE);
    const { container, unmount } = renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <>{segments.map((s) => <div key={s.anchor} data-wiki-comment-section={s.anchor}><WikiMarkdown markdown={s.markdown} links={links} pageMeta={meta} /></div>)}</>
      </QueryClientProvider>,
    );
    if (fixture.name === "bare issue identifier keeps plain text") {
      expect(container.querySelector("[data-issue-chip-title]")?.textContent).toBe("噪音标题不进索引");
    }
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

it.each([false, true])("extracts a selection starting inside visible KaTeX (include following prose: %s)", (includeProse) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container, unmount } = renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <section data-wiki-comment-section="Rules" data-section-title="Rules">
        <WikiMarkdown markdown={"## Rules\n\n$x^2 + y^2$ 后续文字。"} links={[]} />
      </section>
    </QueryClientProvider>,
  );
  const visual = container.querySelector('.katex-html[aria-hidden="true"]')!;
  const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode()!;
  let last = first;
  while (walker.nextNode()) last = walker.currentNode;
  const end = includeProse ? container.querySelector("p")!.lastChild! : last;
  const range = document.createRange(); range.setStart(first, 0); range.setEnd(end, end.textContent!.length);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const exact = includeProse ? "$x^2 + y^2$ 后续文字。" : "$x^2 + y^2$";
  const result = wikiSelectionAnchor(container, selection, 3);
  expect(result?.anchor).toMatchObject({ exact, start: 6, sectionAnchor: "Rules", revisionNumber: 3 });
  const index = indexWikiCommentText(container.querySelector("[data-wiki-markdown]")!);
  expect(locateComment([{ anchor: "Rules", title: "Rules", text: index.text }], result!.anchor)).toMatchObject({ state: "anchored", start: 6 });
  selection.removeAllRanges(); unmount();
});

it.each(["hidden", "aria-hidden", "button", "input", "source", "math-in-hidden-region", "fake-katex"])("still rejects selection noise: %s", (kind) => {
  const { container, unmount } = render(<section data-wiki-comment-section="Rules"><div data-wiki-markdown /></section>);
  const root = container.querySelector("[data-wiki-markdown]")!;
  const node = document.createElement(kind === "button" ? "button" : kind === "input" ? "textarea" : "span");
  node.textContent = "noise text";
  if (kind === "hidden") node.hidden = true;
  if (kind === "aria-hidden" || kind === "fake-katex") node.setAttribute("aria-hidden", "true");
  if (kind === "fake-katex") node.className = "katex-html";
  if (kind === "source") node.setAttribute("data-wiki-comment-source", "source text");
  if (kind === "math-in-hidden-region") {
    root.setAttribute("aria-hidden", "true");
    node.setAttribute("data-math-source", "$x$");
    node.innerHTML = '<span class="katex-html" aria-hidden="true">noise text</span>';
  }
  root.append(node);
  const first = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()!;
  const range = document.createRange(); range.selectNodeContents(first);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(wikiSelectionAnchor(container, selection, 1)).toBeNull();
  selection.removeAllRanges(); unmount();
});
