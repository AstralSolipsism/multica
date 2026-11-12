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

beforeEach(() => {
  replace = vi.fn();
  searchParams = new URLSearchParams();
  getProjectWikiTree = vi.fn(async () => tree());
  getProjectWikiPage = vi.fn(async () => pageRead());
  writeProjectWikiPage = vi.fn(async () => ({ page: pageRead().page, revision: pageRead().revision, rebased: false }));
  createProjectWikiPage = vi.fn(async () => ({ page: tree().pages[1]!, revision: pageRead().revision, rebased: false }));
  setApiInstance({
    getProjectWikiTree, getProjectWikiPage, writeProjectWikiPage, createProjectWikiPage,
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
    expect(screen.queryByTestId("wiki-editor-conflict")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wiki-editor-save"));
    await waitFor(() => expect(writeProjectWikiPage).toHaveBeenCalledTimes(2));
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
});
