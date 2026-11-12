import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance, ApiError } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import type { WikiPageRead, WikiTree } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { EngineeringBaselineWiki } from "./engineering-baseline";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), mockRestore: vi.fn() } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => (type === "agent" ? `Agent ${id}` : "Owner") }),
}));
vi.mock("../../rich-content/rich-code-block", () => ({
  isRichFenceLanguage: (language: string) => language === "mermaid" || language === "html",
  RichFenceBlock: ({ body }: { body: string }) => <div data-testid="rich-fence">{body}</div>,
  CodeBlockShell: ({ code }: { code: string }) => <pre data-testid="code-shell">{code}</pre>,
  StaticCodeBody: ({ body }: { body: string }) => <code>{body}</code>,
}));

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const RULES_ID = "66666666-6666-4666-8666-666666666666";

let replace = vi.fn();
let searchParams = new URLSearchParams();
let getProjectWikiTree: Mock;
let getProjectWikiPage: Mock;
let writeProjectWikiPage: Mock;
let createProjectWikiPage: Mock;

function tree(): WikiTree {
  return {
    pages: [
      {
        id: PAGE_ID, slug: "overview", title: "项目概览", parentId: null, position: 0,
        archivedAt: null, currentRevisionNumber: 6, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
        depth: 1, revisionCount: 6, sections: [{ anchor: "rules", title: "Rules", level: 2 }],
        current: {
          number: 6, kind: "content", createdAt: "2026-11-01T00:00:00Z", createdByType: "member",
          createdById: "22222222-2222-4222-8222-222222222222", changeSummary: "Tighten rules", sourceIssueId: null,
        },
      },
      {
        id: CHILD_ID, slug: "architecture", title: "架构", parentId: PAGE_ID, position: 0,
        archivedAt: null, currentRevisionNumber: 2, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
        depth: 2, revisionCount: 2, sections: [], current: null,
      },
      {
        id: RULES_ID, slug: "rules", title: "规则", parentId: PAGE_ID, position: 1,
        archivedAt: null, currentRevisionNumber: 1, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
        depth: 2, revisionCount: 1, sections: [], current: null,
      },
    ],
    limits: { maxDepth: 6, maxPages: 500 },
  };
}

function pageRead(): WikiPageRead {
  return {
    page: {
      id: PAGE_ID, slug: "overview", title: "项目概览", parentId: null, position: 0,
      archivedAt: null, currentRevisionNumber: 6, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    },
    revision: {
      id: "rev-1", pageId: PAGE_ID, revisionNumber: 6, revisionKind: "content", title: "项目概览",
      slug: "overview", parentId: null, position: 0, archivedAt: null, contentMarkdown: "# 项目概览\n\n## Rules\n\nSee [[架构]].",
      changeSummary: "Tighten rules", baseRevisionId: null, restoredFromRevisionId: null, sourceIssueId: null,
      createdByType: "member", createdById: "22222222-2222-4222-8222-222222222222", createdByTaskId: null,
      createdAt: "2026-11-01T00:00:00Z",
    },
    contentMarkdown: "# 项目概览\n\n## Rules\n\nSee [[架构]].",
    sections: [], referencedSections: [],
    links: [{ raw: "架构", display: "架构", target: "架构", section: "", kind: "page", state: "resolved", targetSlug: "architecture", sectionAnchor: null, candidates: [] }],
    backlinks: [{ slug: "architecture", title: "架构", sectionAnchor: "", snippet: "引用概览" }],
    relatedIssues: [{ id: "99999999-9999-4999-8999-999999999999", identifier: "OL-1304", title: "Refund policy", status: "blocked" }],
  };
}

function renderWiki() {
  const adapter = {
    push: vi.fn(), replace, back: vi.fn(),
    pathname: `/acme/projects/${PROJECT}/engineering`,
    searchParams, hash: "", openInNewTab: vi.fn(), getShareableUrl: (path: string) => path,
  } as unknown as NavigationAdapter;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={adapter}>
        <EngineeringBaselineWiki workspaceSlug="acme" workspaceId={WS} projectId={PROJECT} projectTitle="Apollo" />
      </NavigationProvider>
    </QueryClientProvider>,
    { locale: "zh-Hans" },
  );
}

let moveProjectWikiPage: Mock;
let renameProjectWikiPage: Mock;

beforeEach(() => {
  replace = vi.fn();
  searchParams = new URLSearchParams();
  getProjectWikiTree = vi.fn(async () => tree());
  getProjectWikiPage = vi.fn(async () => pageRead());
  writeProjectWikiPage = vi.fn(async () => ({ page: pageRead().page, revision: pageRead().revision, rebased: false }));
  createProjectWikiPage = vi.fn(async () => ({ page: tree().pages[1]!, revision: pageRead().revision, rebased: false }));
  moveProjectWikiPage = vi.fn(async () => ({ page: pageRead().page, revision: pageRead().revision, rebased: false }));
  renameProjectWikiPage = vi.fn(async () => ({ page: pageRead().page, revision: pageRead().revision, rebased: false }));
  setApiInstance({
    getProjectWikiTree, getProjectWikiPage, writeProjectWikiPage, createProjectWikiPage, moveProjectWikiPage, renameProjectWikiPage,
  } as unknown as ApiClient);
});

describe("EngineeringBaselineWiki", () => {
  it("renders the tree, reader meta, wikilink chip, backlink footer and outline", async () => {
    renderWiki();
    expect(await screen.findByRole("button", { name: "历史版本（6）" })).toBeInTheDocument(); // meta line loaded
    expect(document.querySelector('[data-wiki-tree-page="overview"]')).not.toBeNull();
    // The child row appears once its parent expands.
    fireEvent.click(screen.getByRole("button", { name: "展开或收起「项目概览」" }));
    expect(document.querySelector('[data-wiki-tree-page="architecture"]')).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Rules" })).toHaveAttribute("id", "s-rules");
    expect(screen.getByRole("button", { name: "历史版本（6）" })).toBeInTheDocument();
    expect(screen.getByText("引用概览")).toBeInTheDocument(); // backlink card
    expect(screen.getByText("OL-1304")).toBeInTheDocument(); // related issue chip
    expect(screen.getByLabelText("On this page")).toBeInTheDocument();
  });

  it.each([
    { name: "history wikilink rendering", before: "See [[architecture|认证]] now.", after: "See [[rules|认证]] now.", links: true },
    { name: "history blank-line source change", before: "First paragraph\n\nSecond paragraph", after: "First paragraph\n\n\nSecond paragraph", links: false },
  ])("independent production entry: $name", async ({ before, after, links }) => {
    const getProjectWikiPageRevision = vi.fn(async (_ws: string, _project: string, _page: string, revision: number) => ({
      page: pageRead().page,
      revision: { ...pageRead().revision, id: `revision-${revision}`, revisionNumber: revision, contentMarkdown: revision === 6 ? after : before },
    }));
    setApiInstance({
      getProjectWikiTree, getProjectWikiPage, writeProjectWikiPage, createProjectWikiPage, moveProjectWikiPage, renameProjectWikiPage,
      getProjectWikiPageRevision,
      getProjectWikiPageHistory: vi.fn(async () => ({ revisions: [pageRead().revision], hasMore: false, nextBefore: null })),
    } as unknown as ApiClient);
    renderWiki();
    fireEvent.click(await screen.findByRole("button", { name: "历史版本（6）" }));
    await waitFor(() => expect(getProjectWikiPageRevision).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('[data-wiki-history] [data-wiki-diff-view]')).not.toBeNull());
    const rich = document.querySelector('[data-wiki-history] [data-wiki-diff-view]')!;
    if (links) {
      await waitFor(() => expect(rich.querySelector("[data-wiki-diff-mod]")).not.toBeNull());
      expect(rich.textContent).not.toContain("[[");
      const visible = rich.querySelector('[data-wiki-diff-mod] > div:not([hidden])')!;
      expect(visible.querySelector('[data-wiki-link="architecture"]')).not.toBeNull();
      expect(visible.querySelector('[data-wiki-link="rules"]')).not.toBeNull();

      fireEvent.click(screen.getByRole("tab", { name: "此版本预览" }));
      const preview = document.querySelector('[data-wiki-history] [data-wiki-markdown]')!;
      expect(preview.textContent).not.toContain("[[");
      expect(preview.querySelector('[data-wiki-link="architecture"]')).toBeNull();
      fireEvent.click(preview.querySelector('[data-wiki-link="rules"]')!);
      expect(replace).toHaveBeenCalledWith(expect.stringContaining("page=rules"));
    } else {
      expect(rich.querySelector("[data-wiki-diff-mod], [data-wiki-diff-add], [data-wiki-diff-del], [data-wiki-diff-mod-fallback]")).not.toBeNull();
      expect(document.querySelector("[data-wiki-diff-summary]")?.textContent).toMatch(/[1-9]\d*/);
    }
  });

  it("resolves draft wikilinks from the page tree in the editor preview", async () => {
    renderWiki();
    await screen.findByRole("button", { name: "历史版本（6）" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "See [[architecture|认证]] and [[rules|规范]]." } });
    const editor = screen.getByTestId("wiki-editor-source").closest("[data-wiki-editor]")!;
    fireEvent.click(within(editor as HTMLElement).getByRole("tab", { name: "预览" }));
    const preview = editor.querySelector("[data-wiki-markdown]")!;
    expect(preview.textContent).not.toContain("[[");
    expect(preview.querySelector('[data-wiki-link="architecture"]')?.textContent).toBe("认证");
    expect(preview.querySelector('[data-wiki-link="rules"]')?.textContent).toBe("规范");
  });

  it("resolves historical and latest wikilinks in both 409 conflict views", async () => {
    const initial = pageRead();
    initial.contentMarkdown = "See [[architecture|认证]] now.";
    initial.revision.contentMarkdown = initial.contentMarkdown;
    initial.links = [];
    getProjectWikiPage.mockResolvedValue(initial);
    writeProjectWikiPage.mockRejectedValueOnce(new ApiError("conflict", 409, "Conflict", {
      code: "baseline_conflict",
      current: {
        revision_number: 7, kind: "content", created_at: "2026-11-02T00:00:00Z",
        created_by_type: "agent", created_by_id: "66666666-6666-4666-8666-666666666666", change_summary: "Agent edit", source_issue_id: null,
      },
    }));
    renderWiki();
    await screen.findByRole("button", { name: "历史版本（6）" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    const draft = "Draft [[architecture|草稿]].";
    fireEvent.change(source, { target: { value: draft } });
    const latest = pageRead();
    latest.contentMarkdown = "See [[rules|认证]] now.";
    latest.revision.revisionNumber = 7;
    latest.revision.contentMarkdown = latest.contentMarkdown;
    latest.links = [];
    getProjectWikiPage.mockResolvedValue(latest);
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    const panel = await screen.findByTestId("wiki-editor-conflict", {}, { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "查看对方改了什么" }));
    await waitFor(() => expect(panel.querySelector("[data-wiki-diff-mod]")).not.toBeNull());
    const conflictDiff = panel.querySelector("[data-wiki-diff-view]")!;
    expect(conflictDiff.textContent).not.toContain("[[");
    const visible = conflictDiff.querySelector('[data-wiki-diff-mod] > div:not([hidden])')!;
    expect(visible.querySelector('[data-wiki-link="architecture"]')).not.toBeNull();
    expect(visible.querySelector('[data-wiki-link="rules"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "载入最新并保留草稿" }));
    const compare = await screen.findByTestId("wiki-editor-compare");
    expect(compare.textContent).not.toContain("[[");
    expect(compare.querySelector('[data-wiki-link="architecture"]')?.textContent).toBe("草稿");
    expect(screen.getByTestId("wiki-editor-latest").querySelector('[data-wiki-link="rules"]')?.textContent).toBe("认证");
  });

  it("edits the page and saves with the current tree base revision number", async () => {
    renderWiki();
    await screen.findByRole("heading", { name: "Rules" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "# 项目概览\n\n## Rules\n\nNew body." } });
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    await waitFor(() => expect(writeProjectWikiPage).toHaveBeenCalledExactlyOnceWith(
      WS, PROJECT, "overview",
      expect.objectContaining({ baseRevisionNumber: 6, contentMarkdown: "# 项目概览\n\n## Rules\n\nNew body.", changeSummary: expect.any(String) }),
    ));
  });

  it("shows the three-path conflict panel on a 409 and rebases the draft onto current", async () => {
    writeProjectWikiPage.mockRejectedValueOnce(new ApiError("conflict", 409, "Conflict", {
      code: "baseline_conflict",
      current: {
        revision_number: 7, kind: "content", created_at: "2026-11-02T00:00:00Z",
        created_by_type: "agent", created_by_id: "66666666-6666-4666-8666-666666666666", change_summary: "Agent edit", source_issue_id: null,
      },
    }));
    renderWiki();
    await screen.findByRole("heading", { name: "Rules" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    const draft = "# 项目概览\n\n## Rules\n\nConflicting draft.";
    fireEvent.change(source, { target: { value: draft } });
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    const panel = await screen.findByTestId("wiki-editor-conflict", {}, { timeout: 4000 });
    expect(panel).toHaveTextContent("409");
    // The draft is still in the textarea — nothing was lost.
    expect(source).toHaveValue(draft);

    fireEvent.click(screen.getByRole("button", { name: /载入最新并保留草稿|Load latest/i }));
    // Loading the latest is async (page read); the side-by-side compare view
    // replaces the conflict panel and the footer base becomes v7.
    await waitFor(() => expect(screen.queryByTestId("wiki-editor-conflict")).not.toBeInTheDocument());
    expect(screen.getByTestId("wiki-editor-compare")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-editor-compare")).toHaveTextContent("最新版本 v7");
    expect(screen.getByText("基于 v7 · 保存即发布 v8", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    await waitFor(() => expect(writeProjectWikiPage).toHaveBeenCalledTimes(2));
    expect(writeProjectWikiPage).toHaveBeenLastCalledWith(
      WS, PROJECT, "overview",
      expect.objectContaining({ baseRevisionNumber: 7, contentMarkdown: draft }),
    );
  });

  it("仍然覆盖 retries the write with the conflicted current revision as base", async () => {
    writeProjectWikiPage.mockRejectedValueOnce(new ApiError("conflict", 409, "Conflict", {
      code: "baseline_conflict",
      current: {
        revision_number: 7, kind: "content", created_at: "2026-11-02T00:00:00Z",
        created_by_type: "agent", created_by_id: "66666666-6666-4666-8666-666666666666", change_summary: "Agent edit", source_issue_id: null,
      },
    }));
    renderWiki();
    await screen.findByRole("heading", { name: "Rules" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    const draft = "# 项目概览\n\n## Rules\n\nOverwrite draft.";
    fireEvent.change(source, { target: { value: draft } });
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    await screen.findByTestId("wiki-editor-conflict", {}, { timeout: 4000 });
    // First attempt carried the editor's original base (6, from the read).
    expect(writeProjectWikiPage).toHaveBeenLastCalledWith(
      WS, PROJECT, "overview",
      expect.objectContaining({ baseRevisionNumber: 6, contentMarkdown: draft }),
    );
    fireEvent.click(screen.getByRole("button", { name: "仍然覆盖" }));
    await waitFor(() => expect(writeProjectWikiPage).toHaveBeenCalledTimes(2));
    // The retry must rebase onto the conflicted current revision (7), never
    // the stale base (6) or the tree snapshot's number.
    expect(writeProjectWikiPage).toHaveBeenLastCalledWith(
      WS, PROJECT, "overview",
      expect.objectContaining({ baseRevisionNumber: 7, contentMarkdown: draft }),
    );
  });

  it("creates a child page from the tree hover action and selects it for rename", async () => {
    renderWiki();
    await screen.findByRole("button", { name: "历史版本（6）" });
    fireEvent.click(screen.getByRole("button", { name: "展开或收起「项目概览」" }));
    const overviewRow = document.querySelector('[data-wiki-tree-page="overview"]') as HTMLElement;
    fireEvent.click(within(overviewRow).getByRole("button", { name: /新建子页面|New child page/i }));
    await waitFor(() => expect(createProjectWikiPage).toHaveBeenCalledExactlyOnceWith(
      WS, PROJECT, expect.objectContaining({ title: expect.any(String), parent: "overview" }),
    ));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringContaining("page=architecture")));
  });
  it("derives the editor base from the loaded page read, not the tree snapshot", async () => {
    // Tree says v8 (someone else published), the fresh read returns v7 with
    // the body the editor actually loads: base must follow the READ.
    const read = pageRead();
    read.revision.revisionNumber = 7;
    read.contentMarkdown = "# 项目概览\n\n## Rules\n\nBody v7.";
    getProjectWikiPage.mockResolvedValue(read);
    const treeData = tree();
    treeData.pages[0]!.currentRevisionNumber = 8;
    getProjectWikiTree.mockResolvedValue(treeData);
    renderWiki();
    await screen.findByRole("heading", { name: "Rules" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    expect(source).toHaveValue("# 项目概览\n\n## Rules\n\nBody v7.");
    expect(screen.getByText("基于 v7 · 保存即发布 v8", { exact: false })).toBeInTheDocument();
    fireEvent.change(source, { target: { value: "# 项目概览\n\n## Rules\n\nNew body." } });
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    await waitFor(() => expect(writeProjectWikiPage).toHaveBeenCalledExactlyOnceWith(
      WS, PROJECT, "overview",
      expect.objectContaining({ baseRevisionNumber: 7, contentMarkdown: "# 项目概览\n\n## Rules\n\nNew body." }),
    ));
  });

  it("blocks page switching while the editor is dirty until the user discards", async () => {
    renderWiki();
    await screen.findByRole("heading", { name: "Rules" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "# 项目概览\n\n## Rules\n\nUnsaved draft." } });
    // Tree click while dirty: guard dialog, no navigation yet.
    fireEvent.click(screen.getByRole("button", { name: "展开或收起「项目概览」" }));
    const archRow = await screen.findByText("架构", { selector: '[data-wiki-tree-page="architecture"] button' });
    fireEvent.click(archRow);
    expect(await screen.findByText("有未保存的修改")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    // Keep editing: still here.
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByTestId("wiki-leave-discard")).not.toBeInTheDocument();
    // Discard and switch: editor closes and the page navigates.
    fireEvent.click(document.querySelector('[data-wiki-tree-page="architecture"] button[title="架构"]')!);
    fireEvent.click(await screen.findByTestId("wiki-leave-discard"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringContaining("page=architecture")));
    expect(screen.queryByTestId("wiki-editor-source")).not.toBeInTheDocument();
  });

  it("suggests pages for [[ autocomplete and inserts [[slug|标题]]", async () => {
    renderWiki();
    await screen.findByRole("heading", { name: "Rules" });
    fireEvent.click(screen.getByTestId("wiki-edit-page"));
    const source = (await screen.findByTestId("wiki-editor-source")) as HTMLTextAreaElement;
    const typed = "见 [[arc";
    source.focus();
    source.setSelectionRange(source.value.length, source.value.length);
    fireEvent.change(source, { target: { value: typed } });
    const item = await screen.findByText("架构", { selector: '[data-wiki-suggest-item="architecture"]' });
    expect(item).toHaveTextContent("architecture");
    fireEvent.mouseDown(item.querySelector("button") ?? item);
    expect(source).toHaveValue("见 [[architecture|架构]]");
  });

  it("wires the tree ⋯ menu via onClick and demotes to the PREVIOUS sibling", async () => {
    renderWiki();
    await screen.findByRole("button", { name: "历史版本（6）" });
    fireEvent.click(screen.getByRole("button", { name: "展开或收起「项目概览」" }));
    const rulesRow = document.querySelector('[data-wiki-tree-page="rules"]') as HTMLElement;
    fireEvent.click(within(rulesRow).getByRole("button", { name: "「规则」更多操作" }));
    // Base UI DropdownMenuItem only forwards onClick — the action must fire.
    fireEvent.click(await screen.findByRole("menuitem", { name: /降为上一页的子页/ }));
    await waitFor(() => expect(moveProjectWikiPage).toHaveBeenCalledExactlyOnceWith(
      WS, PROJECT, "rules",
      expect.objectContaining({ parent: "architecture", after: "first", baseRevisionNumber: 1 }),
    ));
  });

  it("bootstraps all four guide pages from one button and is re-runnable past 409s", async () => {
    const empty = tree();
    empty.pages = [];
    getProjectWikiTree.mockResolvedValue(empty);
    renderWiki();
    fireEvent.click(await screen.findByRole("button", { name: /一键创建基线向导/ }));
    await waitFor(() => expect(createProjectWikiPage).toHaveBeenCalledTimes(4));
    expect(createProjectWikiPage.mock.calls.map((call) => call[2]?.slug)).toEqual(
      ["overview", "domain_rules", "architecture", "exclusions_and_risks"],
    );
    // Re-runnable: a 409 slug-taken on an existing page is skipped, the rest
    // still get created.
    createProjectWikiPage.mockClear();
    createProjectWikiPage.mockImplementation(async (_ws: string, _project: string, input: { slug?: string }) => {
      if (input.slug === "overview") throw new ApiError("taken", 409, "Conflict", { code: "baseline_slug_taken" });
      return { page: pageRead().page, revision: pageRead().revision, rebased: false };
    });
    fireEvent.click(await screen.findByRole("button", { name: /一键创建基线向导/ }));
    await waitFor(() => expect(createProjectWikiPage).toHaveBeenCalledTimes(4));
    expect(createProjectWikiPage.mock.calls.map((call) => call[2]?.slug)).toEqual(
      ["overview", "domain_rules", "architecture", "exclusions_and_risks"],
    );
  });
});
