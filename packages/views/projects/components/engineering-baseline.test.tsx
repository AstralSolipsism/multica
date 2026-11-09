import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { useState } from "react";
import type { BaselineChapter, BaselineRevision, ChapterState, IssueGraphNode } from "@multica/core/api";
import { useBaselineAnnotationDraftStore } from "@multica/core/projects/baseline-annotation-draft-store";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { EngineeringBaseline } from "./engineering-baseline";
import { buildEngineeringRoadmap } from "./engineering-utils";

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => type === "agent" ? `Agent ${id}` : `Actor ${id}` }),
}));
vi.mock("../../issues/utils/status-label", () => ({
  useStatusLabel: () => (status: string) => status,
}));

const navigation = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/acme/projects/project-1/engineering",
  searchParams: new URLSearchParams(),
  hash: "",
  openInNewTab: vi.fn(),
  getShareableUrl: (path: string) => path,
} as unknown as NavigationAdapter;

const revision = (status: BaselineRevision["status"] = "candidate"): BaselineRevision => ({
  id: "rev-1",
  workspaceId: "ws-1",
  projectId: "project-1",
  chapter: "domain_rules",
  revisionNumber: 3,
  status,
  contentMarkdown: [
    "### [Rule-1] 幂等键",
    "所有写接口必须携带幂等键，由 OL-42 在 Stage 6 实现。",
    "",
    "为什么：网络重试不能创建重复订单。",
    "",
    "例：同一请求重发两次只创建一个订单。",
    "",
    "### 预占快照",
    "下单时记录库存快照。",
  ].join("\n"),
  changeSummary: "Review wording",
  baseRevisionId: "rev-base",
  replacesRevisionId: null,
  sourceIssueId: null,
  anchorsDiff: {
    chapter: "domain_rules",
    baseRevisionNumber: 2,
    added: [{ anchor: "预占快照", title: "预占快照", before: "", after: "下单时记录库存快照。", beforeChars: 0, afterChars: 10 }],
    modified: [{ anchor: "Rule-1", title: "幂等键", before: "所有写接口应该携带幂等键。", after: "所有写接口必须携带幂等键。", beforeChars: 15, afterChars: 15 }],
    removed: [{ anchor: "Rule-old", title: "旧规则", before: "删除这段旧规则。", after: "", beforeChars: 8, afterChars: 0 }],
    unchangedCount: 0,
    warnings: [{ code: "rule_shrunk", anchor: "Rule-1" }],
  },
  createdByType: "agent",
  createdById: "agent-1",
  createdByTaskId: null,
  createdAt: "2026-01-01T00:00:00Z",
  decidedByType: status === "candidate" ? null : "member",
  decidedById: status === "candidate" ? null : "user-1",
  decidedByTaskId: null,
  decidedAt: status === "candidate" ? null : "2026-01-02T00:00:00Z",
  decisionCredential: status === "candidate" ? null : "pat",
});

const adopted = (): BaselineRevision => ({
  ...revision("adopted"),
  id: "rev-base",
  revisionNumber: 2,
  contentMarkdown: "### [Rule-1] 幂等键\n所有写接口应该携带幂等键。\n\n### [Rule-old] 旧规则\n删除这段旧规则。",
  anchorsDiff: { ...revision().anchorsDiff, added: [], modified: [], removed: [] },
});
const chapter = (candidate: BaselineRevision | null, current: BaselineRevision | null = null): ChapterState => ({ chapter: "domain_rules", title: "", position: 0, adopted: current, candidate });
const nodes = [{ id: "issue-42", identifier: "OL-42", title: "Implement idempotency", stage: 6, status: "in_progress", statusCategory: "started" }] as IssueGraphNode[];
const roadmap = buildEngineeringRoadmap(nodes, [{ stage: 6, title: "Frontend", goal: "Ship the views" }], 6);
const baseProps = {
  workspaceSlug: "acme",
  workspaceId: "ws-1",
  projectId: "project-1",
  projectTitle: "Project",
  selectedChapter: "domain_rules" as const,
  onChapterChange: vi.fn(),
  candidateLoading: false,
  candidateNotFound: false,
  canDecide: true,
  decisionPending: false,
  decisionError: false,
  decisionErrorMessage: "",
  onClearDecisionError: vi.fn(),
  annotations: {
    batches: [],
    details: [],
    loading: false,
    error: false,
    actions: {
      ownerId: "user-1",
      agents: [],
      onSubmitReview: vi.fn(async () => null),
      onResolveAnnotations: vi.fn(async () => null),
      onCloseBatch: vi.fn(async () => null),
    },
  },
  savePending: false,
  onSave: vi.fn(),
  history: null,
  historyLoading: false,
  historyError: false,
  onHistoryMore: vi.fn(),
  chapterRevisions: {},
  roadmap,
  reviewRequested: false,
  pendingCandidates: [revision()],
  batchIds: ["rev-1"],
  processedRevisionIds: new Set<string>(),
  processedCount: 0,
  returnLabel: "Back to overview",
  onReturnFromReview: vi.fn(),
  onSelectCandidate: vi.fn(),
  onOpenProcessed: vi.fn(),
  onReviewCandidate: vi.fn(),
  restorePosition: null,
  lens: "understand" as const,
  onOpenStage: vi.fn(),
};

function renderBaseline(ui: ReactElement) {
  return renderWithI18n(<NavigationProvider value={navigation}>{ui}</NavigationProvider>);
}

function WikiChapterHarness({ chapters, initialChapter = "domain_rules", lens = "understand" }: {
  chapters: readonly ChapterState[];
  initialChapter?: BaselineChapter;
  lens?: "understand" | "manage";
}) {
  const [selectedChapter, setSelectedChapter] = useState<BaselineChapter>(initialChapter);
  return <EngineeringBaseline {...baseProps} chapters={chapters} selectedChapter={selectedChapter} onChapterChange={setSelectedChapter} revision={null} currentCandidate={false} onDecision={vi.fn()} lens={lens} />;
}

beforeEach(() => {
  window.localStorage.clear();
  useBaselineAnnotationDraftStore.getState().clearDraft();
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (options && typeof options === "object") this.scrollTop = options.top ?? 0;
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("EngineeringBaseline review", () => {
  it("renders changes in the Wiki context and decides only the reviewed revision", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn(async () => true);
    const current = revision();
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(current, adopted())]} revision={current} currentCandidate reviewRequested onDecision={onDecision} />);

    await user.click(screen.getByRole("tab", { name: "Rendered view" }));
    await waitFor(() => expect(document.querySelector('[data-diff-kind="modified"]')).toHaveTextContent("所有写接口必须携带幂等键"));
    expect(document.querySelector("[data-diff-before]")).toHaveTextContent("所有写接口应该携带幂等键");
    expect(document.querySelector('[data-diff-kind="added"]')).toHaveTextContent("预占快照");
    expect(document.querySelector('[data-diff-kind="removed"]')).toHaveTextContent("旧规则");
    expect(document.querySelector("[data-baseline-warnings]")).not.toBeInTheDocument();
    expect(screen.getByText(/Agent agent-1/)).toBeInTheDocument();
    expect(screen.queryByText("Source task")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Adopt" }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith("adopt", current));
  });

  it("keeps a historical withdrawn revision read-only", () => {
    const historical = revision("withdrawn");
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, adopted())]} revision={historical} currentCandidate={false} reviewRequested onDecision={vi.fn()} />);

    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByText(/historical revision is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
  });

  it("shows an exact deep-link miss without displaying another candidate", () => {
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(revision(), adopted())]} revision={null} currentCandidate={false} candidateNotFound onDecision={vi.fn()} />);

    expect(screen.getByText("The requested revision was not found")).toBeInTheDocument();
    expect(screen.queryByText("Review wording")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
  });

  it("shows history credentials", () => {
    const current = revision();
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(current, adopted())]} revision={current} currentCandidate history={{ revisions: [revision("adopted")], hasMore: false, nextBefore: null }} onDecision={vi.fn()} />);

    expect(screen.getByText("Confirmed with a personal token")).toBeInTheDocument();
  });
});

describe("EngineeringBaseline Wiki", () => {
  it("renders concept and management references from the controlled lens", async () => {
    const user = userEvent.setup();
    const current = revision();
    const wikiContent = current.contentMarkdown.replace("下单时记录库存快照。", "预占快照依赖幂等键，由 OL-42 在 Stage 6 实现。");
    const chapters = [chapter(null, { ...adopted(), contentMarkdown: wikiContent })];
    const view = renderBaseline(<EngineeringBaseline {...baseProps} chapters={chapters} revision={null} currentCandidate={false} onDecision={vi.fn()} />);

    const article = document.querySelector('[data-baseline-section-key="domain_rules:预占快照"]')!;
    expect(within(article.querySelector("[data-baseline-markdown]") as HTMLElement).getByRole("button", { name: "幂等键" })).toBeInTheDocument();
    expect(within(article.querySelector("[data-baseline-markdown]") as HTMLElement).queryByRole("button", { name: "OL-42" })).not.toBeInTheDocument();
    expect(screen.getByText("Why this rule exists")).toBeInTheDocument();

    view.rerender(<NavigationProvider value={navigation}><EngineeringBaseline {...baseProps} chapters={chapters} revision={null} currentCandidate={false} onDecision={vi.fn()} lens="manage" /></NavigationProvider>);
    const issue = within(article.querySelector("[data-baseline-markdown]") as HTMLElement).getByRole("button", { name: "OL-42" });
    await user.hover(issue);
    expect(await screen.findByText("Implement idempotency")).toBeInTheDocument();
    expect(document.querySelector('[data-reference-card="issue"]')).toHaveTextContent("Stage 6");
    await user.click(issue);
    expect(navigation.push).toHaveBeenCalledWith("/acme/issues/issue-42");
  });

  it("renders explicit short-title links with their display text and no bracket residue", () => {
    const content = "### 权限\n权限定义。\n\n### 调用约束\n显式 [[权限|权限规则]]，普通权限不标。";
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, { ...adopted(), contentMarkdown: content })]} revision={null} currentCandidate={false} onDecision={vi.fn()} />);

    const article = document.querySelector('[data-baseline-section-key="domain_rules:调用约束"]')!;
    const markdown = article.querySelector("[data-baseline-markdown]") as HTMLElement;
    expect(within(markdown).getByRole("button", { name: "权限规则" })).toBeInTheDocument();
    expect(within(markdown).queryByRole("button", { name: "权限" })).not.toBeInTheDocument();
    expect(markdown.textContent).not.toContain("[[");
  });

  it("searches the full Wiki and exposes reading guidance", async () => {
    const user = userEvent.setup();
    const current = revision();
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, { ...adopted(), contentMarkdown: current.contentMarkdown })]} revision={null} currentCandidate={false} onDecision={vi.fn()} />);

    expect(screen.getByText(/Start here/)).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search the baseline" }), "快照");
    expect(screen.getByText("1 matches")).toBeInTheDocument();
    expect(document.querySelector("[data-search-results]")).toHaveTextContent("预占快照");
  });

  it("renders one chapter, resets only the reader on chapter changes, and supports buttons and bracket keys", async () => {
    const user = userEvent.setup();
    const architecture = {
      ...adopted(), id: "architecture-base", chapter: "architecture" as const,
      contentMarkdown: "### Rollback\nRollback plan.",
      anchorsDiff: { ...adopted().anchorsDiff, chapter: "architecture" as const },
    };
    const chapters = [chapter(null, adopted()), { chapter: "architecture" as const, title: "", position: 0, adopted: architecture, candidate: null }];
    renderBaseline(<WikiChapterHarness chapters={chapters} />);
    const reader = document.querySelector<HTMLElement>("[data-baseline-reader]")!;
    const toc = document.querySelector<HTMLElement>("[data-baseline-toc]")!;
    reader.scrollTop = 140;
    toc.scrollTop = 36;

    expect(document.querySelector('[data-baseline-chapter="domain_rules"]')).toBeInTheDocument();
    expect(document.querySelector('[data-baseline-chapter="architecture"]')).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next chapter/ }));
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="architecture"]')).toBeInTheDocument());
    expect(reader.scrollTop).toBe(0);
    expect(toc.scrollTop).toBe(36);
    expect(document.querySelector('[data-baseline-chapter="domain_rules"]')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "[" });
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="domain_rules"]')).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "]" });
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="architecture"]')).toBeInTheDocument());
    expect(toc.scrollTop).toBe(36);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("disables previous on the first chapter and next on the last chapter", async () => {
    renderBaseline(<WikiChapterHarness chapters={[chapter(null, adopted())]} initialChapter="overview" />);
    expect(screen.getByRole("button", { name: /Previous chapter/ })).toBeDisabled();
    fireEvent.keyDown(document, { key: "]" });
    fireEvent.keyDown(document, { key: "]" });
    fireEvent.keyDown(document, { key: "]" });
    expect(await screen.findByRole("button", { name: /Next chapter/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Previous chapter/ })).toBeEnabled();
  });

  it("returns from a cross-chapter search result to the original reader and TOC positions", async () => {
    const user = userEvent.setup();
    const architecture = {
      ...adopted(), id: "architecture-base", chapter: "architecture" as const,
      contentMarkdown: "### Rollback\nRollback plan.",
      anchorsDiff: { ...adopted().anchorsDiff, chapter: "architecture" as const },
    };
    const chapters = [chapter(null, adopted()), { chapter: "architecture" as const, title: "", position: 0, adopted: architecture, candidate: null }];
    renderBaseline(<WikiChapterHarness chapters={chapters} />);
    const reader = document.querySelector<HTMLElement>("[data-baseline-reader]")!;
    const toc = document.querySelector<HTMLElement>("[data-baseline-toc]")!;
    reader.scrollTop = 120;
    toc.scrollTop = 36;

    await user.type(screen.getByRole("searchbox", { name: "Search the baseline" }), "Rollback");
    await user.click(screen.getByRole("button", { name: /Rollback plan/ }));
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="architecture"]')).toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: /Back to/ }));
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="domain_rules"]')).toBeInTheDocument());
    expect(reader.scrollTop).toBe(120);
    expect(toc.scrollTop).toBe(36);
  });

  it("updates reader progress and the active TOC section from reader scrolling", async () => {
    renderBaseline(<WikiChapterHarness chapters={[chapter(null, adopted())]} />);
    const reader = document.querySelector<HTMLElement>("[data-baseline-reader]")!;
    const toc = document.querySelector<HTMLElement>("[data-baseline-toc]")!;
    Object.defineProperty(reader, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(reader, "scrollHeight", { configurable: true, value: 1000 });
    vi.spyOn(reader, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 500));
    const first = document.querySelector<HTMLElement>('[data-baseline-section-key="domain_rules:Rule-1"]')!;
    const second = document.querySelector<HTMLElement>('[data-baseline-section-key="domain_rules:Rule-old"]')!;
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -100, 600, 100));
    let secondTop = 200;
    vi.spyOn(second, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, secondTop, 600, 100));

    reader.scrollTop = 250;
    fireEvent.scroll(reader);
    expect(document.querySelector("[data-reader-progress]")).toHaveStyle({ width: "50%" });
    expect(within(toc).getByRole("button", { name: "幂等键" })).toHaveAttribute("aria-current", "location");
    secondTop = 50;
    reader.scrollTop = 500;
    fireEvent.scroll(reader);
    expect(document.querySelector("[data-reader-progress]")).toHaveStyle({ width: "100%" });
    expect(within(toc).getByRole("button", { name: "旧规则" })).toHaveAttribute("aria-current", "location");
  });

  it("renders dynamic modules with cross-chapter cards, backlinks, and return navigation", async () => {
    const user = userEvent.setup();
    const global = { ...adopted(), contentMarkdown: "### 幂等键\n全局幂等定义。" };
    const module = {
      ...adopted(),
      id: "module-base",
      chapter: "module:billing" as const,
      contentMarkdown: "### 计费请求\n使用 [[幂等键]] 防止重复扣款。",
      anchorsDiff: { ...adopted().anchorsDiff, chapter: "module:billing" as const },
    };
    const chapters = [
      chapter(null, global),
      { chapter: "module:billing" as const, title: "Billing and settlement", position: 1, adopted: module, candidate: null },
    ];
    const view = renderBaseline(<WikiChapterHarness chapters={chapters} />);

    const toc = document.querySelector('aside[aria-label="Baseline contents"]') as HTMLElement;
    expect(within(toc).getByText("Global outline")).toBeInTheDocument();
    expect(within(toc).getByText("Functional modules")).toBeInTheDocument();
    await user.click(within(toc).getByRole("button", { name: "Billing and settlement" }));
    const moduleArticle = document.querySelector('[data-baseline-section-key="module:billing:计费请求"]') as HTMLElement;
    expect(document.querySelector('[data-baseline-section-key="domain_rules:幂等键"]')).not.toBeInTheDocument();
    const concept = within(moduleArticle.querySelector("[data-baseline-markdown]") as HTMLElement).getByRole("button", { name: "幂等键" });
    await user.hover(concept);
    await waitFor(() => expect(document.querySelector('[data-reference-card="concept"]')).toHaveTextContent("Domain and rules"));
    expect(document.querySelector('[data-reference-card="concept"]')).toHaveTextContent("全局幂等定义");

    await user.click(concept);
    expect(await screen.findByText('Back to "计费请求"')).toBeInTheDocument();
    expect(document.querySelector('[data-baseline-section-key="domain_rules:幂等键"]')).toBeInTheDocument();
    expect(document.querySelector('[data-baseline-section-key="module:billing:计费请求"]')).not.toBeInTheDocument();
    await user.click(screen.getByText('Back to "计费请求"'));
    expect(screen.queryByText('Back to "计费请求"')).not.toBeInTheDocument();
    expect(document.querySelector('[data-baseline-section-key="module:billing:计费请求"]')).toBeInTheDocument();

    view.rerender(<NavigationProvider value={navigation}><WikiChapterHarness chapters={chapters} lens="manage" /></NavigationProvider>);
    const managedModule = document.querySelector('[data-baseline-section-key="module:billing:计费请求"]') as HTMLElement;
    await user.click(within(managedModule.querySelector("[data-baseline-markdown]") as HTMLElement).getByRole("button", { name: "幂等键" }));
    const globalArticle = document.querySelector('[data-baseline-section-key="domain_rules:幂等键"]') as HTMLElement;
    expect(globalArticle.querySelector('[data-section-relations="management"]')).toHaveTextContent("Referenced by");
    expect(within(globalArticle).getByRole("button", { name: "计费请求" })).toBeInTheDocument();
  });

  it("creates a module with an automatic slug that can be customized", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ revision: { ...revision(), chapter: "module:billing_core" } });
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, adopted())]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Add module chapter" }));
    const dialog = screen.getByRole("dialog", { name: "Add module chapter" });
    await user.type(within(dialog).getByRole("textbox", { name: "Module name" }), "Billing & Settlement");
    const slug = within(dialog).getByRole("textbox", { name: "Chapter slug" });
    expect(slug).toHaveValue("billing-settlement");
    await user.clear(slug);
    await user.type(slug, "billing_core");
    await user.type(within(dialog).getByRole("textbox", { name: "Markdown content" }), "## Billing rules\nUse idempotency.");
    await user.type(within(dialog).getByRole("textbox", { name: "Change summary" }), "Create billing module");
    await user.click(within(dialog).getByRole("button", { name: "Submit for review" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      chapter: "module:billing_core",
      chapterTitle: "Billing & Settlement",
      contentMarkdown: "## Billing rules\nUse idempotency.",
      changeSummary: "Create billing module",
    }, false));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("renames a module through the existing proposal flow without changing its slug", async () => {
    const user = userEvent.setup();
    const module = {
      ...adopted(),
      chapter: "module:billing" as const,
      contentMarkdown: "## Billing rules\nExisting content.",
      anchorsDiff: { ...adopted().anchorsDiff, chapter: "module:billing" as const },
    };
    const onSave = vi.fn().mockResolvedValue({ revision: module });
    renderBaseline(<EngineeringBaseline {...baseProps} selectedChapter="module:billing" chapters={[{ chapter: "module:billing", title: "Billing", position: 1, adopted: module, candidate: null }]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Edit title" }));
    const dialog = screen.getByRole("dialog", { name: "Edit module title" });
    const title = within(dialog).getByRole("textbox", { name: "Module name" });
    await user.clear(title);
    await user.type(title, "Billing and settlement");
    await user.type(within(dialog).getByRole("textbox", { name: "Change summary" }), "Rename billing module");
    await user.click(within(dialog).getByRole("button", { name: "Save and adopt" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      chapter: "module:billing",
      chapterTitle: "Billing and settlement",
      contentMarkdown: "## Billing rules\nExisting content.",
      changeSummary: "Rename billing module",
    }, true));
  });

  it("edits only one section and submits its anchor and complete Markdown subtree", async () => {
    const user = userEvent.setup();
    const content = "## [Rule-1] 幂等键\n旧正文。\n\n### 子规则\n保留子节。\n\n## 预占快照\n其他内容。";
    const onSave = vi.fn().mockResolvedValue({ revision: { ...revision(), contentMarkdown: content } });
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, { ...adopted(), contentMarkdown: content })]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    const article = document.querySelector('[data-baseline-section-key="domain_rules:Rule-1"]') as HTMLElement;
    await user.click(within(article).getByRole("button", { name: "Edit section" }));
    const editor = article.querySelector("[data-baseline-section-editor]") as HTMLElement;
    const markdown = within(editor).getByRole("textbox", { name: "Markdown content" });
    expect(markdown).toHaveValue("## [Rule-1] 幂等键\n旧正文。\n\n### 子规则\n保留子节。");
    await user.clear(markdown);
    await user.paste("## [Rule-1] 幂等键\n新正文。");
    await user.type(within(editor).getByRole("textbox", { name: "Change summary" }), "Clarify idempotency");
    await user.click(within(editor).getByRole("button", { name: "Save and adopt" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      chapter: "domain_rules",
      contentMarkdown: "## [Rule-1] 幂等键\n新正文。",
      changeSummary: "Clarify idempotency",
      section: "Rule-1",
    }, true));
  });

  it.each([
    {
      name: "repeated H3 headings",
      content: "## 计费\n### 示例\n旧内容。\n## 结算\n### 示例\n旧内容。",
      key: "domain_rules:结算 / 示例",
      query: "结算 / 示例",
      source: "### 示例\n旧内容。",
    },
    {
      name: "the second duplicate H2 heading",
      content: "## 重名\n第一节。\n## 重名\n第二节。",
      key: "domain_rules:重名 (2)",
      query: "重名 (2)",
      source: "## 重名\n第二节。",
    },
    {
      name: "a bracketed title without an explicit key",
      content: "## [可选] 计费\n旧内容。",
      key: "domain_rules:[可选] 计费",
      query: "[可选] 计费",
      source: "## [可选] 计费\n旧内容。",
    },
  ])("submits a unique backend anchor for $name", async ({ content, key, query, source }) => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ revision: { ...revision(), contentMarkdown: content } });
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, { ...adopted(), contentMarkdown: content })]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    const article = document.querySelector(`[data-baseline-section-key="${key}"]`) as HTMLElement;
    await user.click(within(article).getByRole("button", { name: "Edit section" }));
    const editor = article.querySelector("[data-baseline-section-editor]") as HTMLElement;
    const markdown = within(editor).getByRole("textbox", { name: "Markdown content" });
    expect(markdown).toHaveValue(source);
    await user.clear(markdown);
    await user.paste(`${source}\n更新。`);
    await user.type(within(editor).getByRole("textbox", { name: "Change summary" }), "Update section");
    await user.click(within(editor).getByRole("button", { name: "Submit for review" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      chapter: "domain_rules",
      contentMarkdown: `${source}\n更新。`,
      changeSummary: "Update section",
      section: query,
    }, false));
  });

  it("uses whole-chapter editing instead of local edits while a candidate is pending", () => {
    const pending = { ...revision(), id: "pending", contentMarkdown: "### [Rule-1] 幂等键\n候选修改。\n\n### 预占快照\n候选中的其他修改。" };
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(pending, adopted())]} revision={null} currentCandidate={false} onDecision={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Edit section" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-section-edit-hint]")).toHaveTextContent("This chapter has a pending candidate. Use Edit chapter to preserve its changes.");
    expect(screen.getByRole("button", { name: "Edit chapter" })).toBeEnabled();
  });

  it("does not directly adopt hidden candidate content when renaming a module", async () => {
    const user = userEvent.setup();
    const current = {
      ...adopted(),
      chapter: "module:billing" as const,
      contentMarkdown: "## Billing rules\nAdopted content.",
      anchorsDiff: { ...adopted().anchorsDiff, chapter: "module:billing" as const },
    };
    const pending = {
      ...revision(),
      id: "pending-module",
      chapter: "module:billing" as const,
      contentMarkdown: "## Billing rules\nUnreviewed candidate content.",
      anchorsDiff: { ...revision().anchorsDiff, chapter: "module:billing" as const },
    };
    const onSave = vi.fn().mockResolvedValue({ revision: pending });
    renderBaseline(<EngineeringBaseline {...baseProps} selectedChapter="module:billing" chapters={[{ chapter: "module:billing", title: "Billing", position: 1, adopted: current, candidate: pending }]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Edit title" }));
    const dialog = screen.getByRole("dialog", { name: "Edit module title" });
    expect(within(dialog).queryByRole("button", { name: "Save and adopt" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Change summary" }), "Rename only");
    await user.click(within(dialog).getByRole("button", { name: "Submit for review" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      chapter: "module:billing",
      contentMarkdown: "## Billing rules\nUnreviewed candidate content.",
    }), false));
  });

  it("blocks duplicate module slugs and restores focus to the opener", async () => {
    const user = userEvent.setup();
    const module = { ...adopted(), chapter: "module:billing" as const, anchorsDiff: { ...adopted().anchorsDiff, chapter: "module:billing" as const } };
    const onSave = vi.fn();
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[{ chapter: "module:billing", title: "Billing", position: 1, adopted: module, candidate: null }]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    const opener = screen.getByRole("button", { name: "Add module chapter" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Add module chapter" });
    await user.type(within(dialog).getByRole("textbox", { name: "Module name" }), "New module");
    const slug = within(dialog).getByRole("textbox", { name: "Chapter slug" });
    await user.clear(slug);
    await user.type(slug, "billing");
    await user.type(within(dialog).getByRole("textbox", { name: "Markdown content" }), "## New\nDo not overwrite.");
    await user.type(within(dialog).getByRole("textbox", { name: "Change summary" }), "Duplicate slug");

    expect(within(dialog).getByText("This module chapter already exists.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Submit for review" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save and adopt" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("blocks malformed custom slugs before submitting", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, adopted())]} revision={null} currentCandidate={false} onDecision={vi.fn()} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Add module chapter" }));
    const dialog = screen.getByRole("dialog", { name: "Add module chapter" });
    await user.type(within(dialog).getByRole("textbox", { name: "Module name" }), "Billing");
    const slug = within(dialog).getByRole("textbox", { name: "Chapter slug" });
    await user.clear(slug);
    await user.type(slug, "Billing/settlement");
    await user.type(within(dialog).getByRole("textbox", { name: "Markdown content" }), "## Billing");
    await user.type(within(dialog).getByRole("textbox", { name: "Change summary" }), "Invalid slug");

    expect(within(dialog).getByText(/Use 1–63 lowercase letters/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Submit for review" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save and adopt" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not offer local editing for an untitled preamble", () => {
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, { ...adopted(), contentMarkdown: "Preamble without a heading." })]} revision={null} currentCandidate={false} onDecision={vi.fn()} />);

    const article = document.querySelector('[data-baseline-section-key="domain_rules:intro"]') as HTMLElement;
    expect(within(article).queryByRole("button", { name: "Edit section" })).not.toBeInTheDocument();
  });

  it("shows a module's custom title on a concept card from the global outline", async () => {
    const user = userEvent.setup();
    const global = { ...adopted(), contentMarkdown: "### 全局约束\n使用 [[计费请求]]。" };
    const module = {
      ...adopted(),
      id: "module-base",
      chapter: "module:billing" as const,
      contentMarkdown: "### 计费请求\n模块内定义。",
      anchorsDiff: { ...adopted().anchorsDiff, chapter: "module:billing" as const },
    };
    renderBaseline(<EngineeringBaseline {...baseProps} chapters={[chapter(null, global), { chapter: "module:billing", title: "Billing and settlement", position: 1, adopted: module, candidate: null }]} revision={null} currentCandidate={false} onDecision={vi.fn()} />);

    const globalArticle = document.querySelector('[data-baseline-section-key="domain_rules:全局约束"]') as HTMLElement;
    await user.hover(within(globalArticle.querySelector("[data-baseline-markdown]") as HTMLElement).getByRole("button", { name: "计费请求" }));
    await waitFor(() => expect(document.querySelector('[data-reference-card="concept"]')).toHaveTextContent("Billing and settlement"));
    expect(document.querySelector('[data-reference-card="concept"]')).not.toHaveTextContent("module:billing");
  });
});
