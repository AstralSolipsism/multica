import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import type { WikiActivityItem, WikiTree } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { EngineeringOverview } from "./engineering-overview";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: OWNER } }),
}));
vi.mock("@multica/core/issues/dag/use-dag-data", () => ({
  useDagGraph: () => ({ data: { nodes: [] }, isLoading: false, isError: false }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => (type === "agent" ? `Agent ${id}` : "Owner") }),
}));
vi.mock("./engineering-baseline-diff", () => ({
  WikiDiffSummary: () => null,
  WikiDiffView: ({ before, after }: { before: string; after: string }) => <div data-wiki-diff-view><del data-wiki-diff-del>{before}</del><ins data-wiki-diff-add>{after}</ins></div>,
}));
vi.mock("../../rich-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rich-content")>();
  return { ...actual, RichContent: ({ content }: { content: string }) => <div data-testid="decision-rich-content">{content}</div> };
});
vi.mock("../../issues/components/issue-mention-card", () => ({
  IssueMentionCard: ({ issueId, fallbackLabel }: { issueId: string; fallbackLabel?: string }) => (
    <span data-testid="issue-mention-card">{fallbackLabel ?? issueId}</span>
  ),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">{`${actorType}:${actorId}`}</span>
  ),
}));

const OWNER = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";

let replace = vi.fn();
let push = vi.fn();
let getProjectWikiTree: Mock;
let getProjectWikiActivity: Mock;
let activityItems: WikiActivityItem[];

function tree(): WikiTree {
  return {
    pages: [
      { id: "44444444-4444-4444-8444-444444444444", slug: "overview", title: "项目概览", parentId: null, position: 0, archivedAt: null, currentRevisionNumber: 3, createdAt: "", updatedAt: "", depth: 1, revisionCount: 3, sections: [], current: null },
      { id: "55555555-5555-4555-8555-555555555555", slug: "architecture", title: "架构", parentId: null, position: 1, archivedAt: null, currentRevisionNumber: 1, createdAt: "", updatedAt: "", depth: 1, revisionCount: 1, sections: [], current: null },
    ],
    limits: { maxDepth: 6, maxPages: 500 },
  };
}

function activity(): WikiActivityItem[] {
  return activityItems;
}

beforeEach(() => {
  replace = vi.fn();
  push = vi.fn();
  // searchParams reset per test via the adapter below.
  activityItems = [
    {
      pageId: "44444444-4444-4444-8444-444444444444", slug: "overview", title: "项目概览", kind: "create",
      number: 1, createdAt: "2026-11-01T00:00:00Z", createdByType: "member",
      createdById: OWNER, changeSummary: "Initial import", sourceIssueId: null,
    },
    {
      pageId: "55555555-5555-4555-8555-555555555555", slug: "architecture", title: "架构", kind: "rollback",
      number: 4, createdAt: "2026-11-02T00:00:00Z", createdByType: "agent",
      createdById: "agent-1", changeSummary: "", sourceIssueId: null,
    },
  ];
  getProjectWikiTree = vi.fn(async () => tree());
  getProjectWikiActivity = vi.fn(async () => ({ items: activity(), }));
  setApiInstance({
    getProject: vi.fn(async () => ({ id: PROJECT, title: "Apollo", identifier: "OL-1" })),
    getProjectEngineering: vi.fn(async () => ({
      engineering: {
        projectId: PROJECT, workspaceId: WS, enabled: true, currentStage: 1, modeSummary: "",
        deciderMemberIds: [OWNER], stages: [{ stage: 1, title: "Stage 1", goal: "" }],
      },
      chapters: [],
    })),
    listMembers: vi.fn(async () => [{ user_id: OWNER, name: "Owner", role: "owner" }]),
    listAgents: vi.fn(async () => []),
    listIssues: vi.fn(async () => ({ issues: [], total: 0 })),
    listTimeline: vi.fn(async () => []),
    getProjectWikiTree,
    getProjectWikiActivity,
    getProjectWikiPage: vi.fn(async () => { throw new Error("not needed"); }),
    getProjectWikiPageRevision: vi.fn(async (_ws: string, _project: string, _page: string, number: number) => ({
      page: null,
      revision: { id: `rev-${number}`, revisionNumber: number, contentMarkdown: number === 4 ? "after change" : "before change" },
    })),
  } as unknown as ApiClient);
});

function renderOverview(search = "") {
  const adapter = {
    push, replace, back: vi.fn(),
    pathname: `/acme/projects/${PROJECT}/engineering`,
    searchParams: new URLSearchParams(search), hash: "",
    openInNewTab: vi.fn(), getShareableUrl: (path: string) => path,
  } as unknown as NavigationAdapter;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={adapter}>
        <EngineeringOverview workspaceSlug="acme" projectId={PROJECT} />
      </NavigationProvider>
    </QueryClientProvider>,
    { locale: "zh-Hans" },
  );
}

describe("EngineeringOverview", () => {
  it("shows the one-screen board with the live page count and one latest change", async () => {
    renderOverview();
    await waitFor(() => expect(document.querySelector("[data-engineering-board]")).not.toBeNull(), { timeout: 3000 });
    await screen.findByText("2 个页面", {}, { timeout: 3000 });
    expect(screen.getByTestId("wiki-enter")).toHaveTextContent("2 个页面");
    expect(document.querySelector("[data-board-latest-activity]")).toHaveTextContent("Initial import");
    expect(screen.getByText("推进正常 · 无阻塞")).toBeInTheDocument();
    expect(screen.queryByTestId("wiki-summary-card")).not.toBeInTheDocument();
  });

  it("previews the selected revision as a Rich Diff and deep-links into full history", async () => {
    renderOverview("tab=activity");
    await waitFor(() => expect(document.querySelector("[data-engineering-activity]")).not.toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(document.body.textContent).toContain("新建页面"), { timeout: 3000 });
    expect(document.body.textContent).toContain("回滚");
    fireEvent.click(document.querySelector('[data-activity-row="55555555-5555-4555-8555-555555555555:4"]')!);
    await waitFor(() => expect(document.querySelector("[data-engineering-activity] [data-wiki-diff-add]")).not.toBeNull());
    expect(document.querySelector("[data-activity-preview]")?.textContent).toContain("before change");
    expect(document.querySelector("[data-activity-preview]")?.textContent).toContain("after change");
    fireEvent.click(screen.getByRole("button", { name: "完整历史对比 →" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringContaining("tab=wiki&page=architecture&history=1&rev=4")));
  });

  it("maps legacy page links to Wiki and supports the independent unstaged stage", async () => {
    const legacy = renderOverview("page=architecture");
    await waitFor(() => expect(screen.getByRole("tab", { name: /基线 Wiki/ })).toHaveAttribute("aria-selected", "true"), { timeout: 3000 });
    await waitFor(() => expect(document.querySelector("[data-wiki-shell]")).not.toBeNull());
    legacy.unmount();

    renderOverview("tab=stages&stage=unstaged");
    await waitFor(() => expect(document.getElementById("engineering-roadmap")).not.toBeNull());
    expect(document.querySelector('[data-stage-node="unstaged"]')).toHaveAttribute("aria-current", "step");
    expect(document.querySelector('[data-engineering-region="outside"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-engineering-region='outside']")).toHaveLength(1);
  });

  it("uses healthy progress buckets instead of an empty decision queue", async () => {
    renderOverview();
    await waitFor(() => expect(document.querySelector("[data-engineering-board]")).not.toBeNull(), { timeout: 3000 });
    expect(screen.queryByTestId("candidate-todo")).not.toBeInTheDocument();
    expect(document.querySelector("[data-review-todo]")).toBeNull();
    expect(document.querySelector("[data-engineering-region='decisions']")).toBeNull();
    expect(document.querySelector("[data-board-buckets]")).not.toBeNull();
    expect(screen.queryByText("眼下没有要你处理的事，团队正在继续推进。")).not.toBeInTheDocument();
  });
});
