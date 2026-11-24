import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import type { WikiActivityItem, WikiTree, IssueGraphNode } from "@multica/core/api";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { issueKeys } from "@multica/core/issues/queries";
import { useHtmlBlockHostActions, type HtmlBlockHostActions } from "../../editor/html-block-host-actions";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { EngineeringOverview } from "./engineering-overview";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: OWNER } }),
}));
let listFailed = false;
let graphNodes: IssueGraphNode[] = [];

vi.mock("@multica/core/issues/dag/use-dag-data", () => ({
  useDagGraph: () => ({ data: { nodes: graphNodes }, isLoading: false, isError: false }),
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
  return { ...actual, RichContent: ({ content }: { content: string }) => {
    latestHostActions = useHtmlBlockHostActions();
    return <div data-testid="decision-rich-content">{content}</div>;
  } };
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
let updateProjectEngineering: Mock;
let activityItems: WikiActivityItem[];
let latestHostActions: HtmlBlockHostActions | null = null;
let engineeringStages: { stage: number; title: string; goal: string }[];
let blockedIssues: Issue[];
let timelinesByIssue: Record<string, TimelineEntry[]>;
let timelineErrors: Record<string, boolean>;
let listTimeline: Mock;
let createComment: Mock;

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

function decisionIssue(id = "issue-1"): Issue {
  return {
    id, workspace_id: WS, number: 1, identifier: "OL-1", title: "Decision", description: null,
    status: "blocked", status_category: "started", priority: "high", assignee_type: "squad", assignee_id: "squad-1",
    creator_type: "member", creator_id: OWNER, parent_issue_id: null, project_id: PROJECT, position: 0, stage: 1,
    start_date: null, due_date: null, metadata: {}, properties: {}, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
  } as Issue;
}

function cardEntry(id: string, marker = "card"): TimelineEntry {
  return {
    id, type: "comment", actor_type: "agent", actor_id: "agent-1", content: `\`\`\`html title="决策卡：${marker}"\n${marker}`,
    parent_id: null, resolved_at: null, deleted_at: null, created_at: "2026-11-02T00:00:00Z", reactions: [], attachments: [],
  } as TimelineEntry;
}

function stagedNode(stage: number): IssueGraphNode {
  return {
    id: "task-stage", identifier: "OL-99", title: "Existing staged task", status: "in_progress", statusCategory: "started",
    revision: 1, parentIssueId: null, hasRestrictedParent: false, projectId: PROJECT, stage, priority: "high",
    assignee: null, role: "match", runSummary: null, dependencySummary: null,
  };
}

beforeEach(() => {
  replace = vi.fn();
  push = vi.fn();
  listFailed = false;
  graphNodes = [];
  latestHostActions = null;
  engineeringStages = [{ stage: 1, title: "Stage 1", goal: "" }];
  blockedIssues = [];
  timelinesByIssue = {};
  timelineErrors = {};
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
  updateProjectEngineering = vi.fn(async () => ({ engineering: {} }));
  createComment = vi.fn(async (issueId: string, content: string, _type: string | undefined, parentId: string | undefined) => ({
    id: `answer-${parentId ?? "root"}`, issue_id: issueId, content, parent_id: parentId ?? null,
    author_type: "member", author_id: OWNER, created_at: "2026-11-24T00:00:00Z", reactions: [], attachments: [],
  }));
  listTimeline = vi.fn(async (issueId: string) => {
    if (timelineErrors[issueId]) throw new Error("timeline unavailable");
    return timelinesByIssue[issueId] ?? [];
  });
  setApiInstance({
    getProject: vi.fn(async () => ({ id: PROJECT, title: "Apollo", identifier: "OL-1" })),
    getProjectEngineering: vi.fn(async () => ({
      engineering: {
        projectId: PROJECT, workspaceId: WS, enabled: true, currentStage: 1, modeSummary: "",
        deciderMemberIds: [OWNER], stages: engineeringStages,
      },
      chapters: [],
    })),
    updateProjectEngineering,
    listMembers: vi.fn(async () => [{ user_id: OWNER, name: "Owner", role: "owner" }]),
    listAgents: vi.fn(async () => []),
    listIssues: vi.fn(async () => {
      if (listFailed) throw new Error("blocked issue list unavailable");
      return { issues: blockedIssues, total: blockedIssues.length };
    }),
    listTimeline,
    createComment,
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
  const view = renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={adapter}>
        <EngineeringOverview workspaceSlug="acme" projectId={PROJECT} />
      </NavigationProvider>
    </QueryClientProvider>,
    { locale: "zh-Hans" },
  );
  return { ...view, queryClient };
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

  it("lets deciders cancel or save the delivery strategy from the board", async () => {
    renderOverview();
    await waitFor(() => expect(document.querySelector("[data-engineering-board]")).not.toBeNull(), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "推进方针" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑方针" }));
    let editor = screen.getByRole("textbox", { name: "推进方针" });
    fireEvent.change(editor, { target: { value: "不保存的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("textbox", { name: "推进方针" })).not.toBeInTheDocument();
    expect(updateProjectEngineering).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "编辑方针" }));
    editor = screen.getByRole("textbox", { name: "推进方针" });
    fireEvent.change(editor, { target: { value: "按阶段交付并集中拍板" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateProjectEngineering).toHaveBeenCalledWith(WS, PROJECT, { modeSummary: "按阶段交付并集中拍板" }));
    expect(screen.queryByRole("textbox", { name: "推进方针" })).not.toBeInTheDocument();
  });

  it("uses healthy progress buckets instead of an empty decision queue", async () => {
    renderOverview();
    await waitFor(() => expect(document.querySelector("[data-engineering-board]")).not.toBeNull(), { timeout: 3000 });
    expect(screen.queryByTestId("candidate-todo")).not.toBeInTheDocument();
    expect(document.querySelector("[data-review-todo]")).toBeNull();
    expect(document.querySelector("[data-engineering-region='decisions']")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-board-buckets]")).not.toBeNull());
    expect(screen.queryByText("眼下没有要你处理的事，团队正在继续推进。")).not.toBeInTheDocument();
  });

  it("does not call a blocked Issue healthy while its timeline is still loading", async () => {
    const pending = Promise.withResolvers<TimelineEntry[]>();
    blockedIssues = [decisionIssue()];
    listTimeline.mockReturnValue(pending.promise);
    renderOverview();
    await screen.findAllByText("正在加载最新上下文");
    expect(document.querySelector("[data-board-buckets]")).toBeNull();
    await act(async () => pending.resolve([]));
    await waitFor(() => expect(document.querySelector("[data-board-buckets]")).not.toBeNull());
  });

  it("keeps timeline failures in the queue and retries only that context", async () => {
    const issue = decisionIssue();
    blockedIssues = [issue];
    timelinesByIssue[issue.id] = [cardEntry("comment-retry", "retry-card")];
    timelineErrors[issue.id] = true;
    renderOverview();
    await screen.findAllByText("决策上下文加载失败。");
    expect(screen.queryByText("推进正常 · 无阻塞")).not.toBeInTheDocument();

    delete timelineErrors[issue.id];
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/retry-card/, {}, { timeout: 3000 });
    expect(listTimeline.mock.calls.filter(([id]) => id === issue.id)).toHaveLength(2);
  });

  it("consumes only the submitted card and restores the same Issue when a new card arrives", async () => {
    const issue = decisionIssue();
    blockedIssues = [issue];
    timelinesByIssue[issue.id] = [cardEntry("comment-1", "first-card")];
    const view = renderOverview();
    await screen.findByText(/first-card/, {}, { timeout: 3000 });

    await act(async () => {
      expect(await latestHostActions?.submitComment?.("answer", "card-key")).toBe(true);
    });
    expect(createComment).toHaveBeenCalledWith(issue.id, "answer", undefined, "comment-1", undefined, undefined, undefined);
    await waitFor(() => expect(document.querySelector("[data-board-buckets]")).not.toBeNull());

    timelinesByIssue[issue.id] = [cardEntry("comment-2", "second-card")];
    await act(() => view.queryClient.invalidateQueries({ queryKey: issueKeys.timeline(issue.id) }));
    await screen.findByText(/second-card/, {}, { timeout: 3000 });
    expect(document.querySelector("[data-board-buckets]")).toBeNull();
  });

  it("uses stages derived from actual tasks before considering cold start", async () => {
    engineeringStages = [];
    graphNodes = [stagedNode(4)];
    getProjectWikiTree.mockResolvedValue({ pages: [], limits: { maxDepth: 6, maxPages: 500 } });
    renderOverview();
    await waitFor(() => expect(document.querySelector("[data-engineering-board]")).not.toBeNull());
    expect(document.querySelector("[data-engineering-cold-start]")).toBeNull();
  });

  it("shows a retryable Wiki tree error without trapping an existing project in cold start", async () => {
    getProjectWikiTree.mockRejectedValue(new Error("tree unavailable"));
    renderOverview();
    await screen.findByText("无法加载页面树，请重试。");
    expect(document.querySelector("[data-engineering-board]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("pages activity with the before cursor until a filtered older page has a match", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      pageId: "44444444-4444-4444-8444-444444444444", slug: "overview", title: "项目概览", kind: "content",
      number: index + 1, createdAt: new Date(Date.UTC(2026, 10, 20, 0, 0, 50 - index)).toISOString(), createdByType: "member",
      createdById: OWNER, changeSummary: `Recent ${index + 1}`, sourceIssueId: null,
    })) as WikiActivityItem[];
    const older = { ...firstPage[0]!, pageId: "55555555-5555-4555-8555-555555555555", slug: "architecture", title: "架构", number: 51, changeSummary: "Older match" };
    getProjectWikiActivity.mockImplementation(async (_ws: string, _project: string, options: { before?: string }) => ({ items: options.before ? [older] : firstPage }));
    renderOverview("tab=activity");
    await waitFor(() => expect(document.querySelectorAll("[data-activity-row]")).toHaveLength(50));

    await userEvent.click(document.querySelector('[data-slot="select-trigger"]')!);
    await userEvent.click(await screen.findByRole("option", { name: "架构" }));
    await waitFor(() => expect(getProjectWikiActivity).toHaveBeenCalledWith(WS, PROJECT, { limit: 50, before: new Date(Date.parse(firstPage[49]!.createdAt) + 1).toISOString() }), { timeout: 3000 });
    await waitFor(() => expect(document.body.textContent).toContain("Older match"), { timeout: 3000 });
  });
});

it("review boundary: healthy status requires successful blocked-issue discovery", async () => {
  listFailed = true;
  renderOverview();
  await screen.findByText("待拍板任务加载失败。");
  expect(screen.queryByText("推进正常 · 无阻塞")).toBeNull();
});

it("review boundary: a slow timeline leaves the other loaded card usable", async () => {
  const pending = Promise.withResolvers<TimelineEntry[]>();
  blockedIssues = [decisionIssue("issue-1"), { ...decisionIssue("issue-2"), identifier: "OL-2" }];
  listTimeline.mockImplementation(async (id: string) =>
    id === "issue-2" ? pending.promise : [cardEntry("a", "ready-card")],
  );
  renderOverview();
  try {
    await waitFor(() => expect(listTimeline).toHaveBeenCalledTimes(2));
    await screen.findByText(/ready-card/);
  } finally {
    await act(async () => pending.resolve([]));
  }
});

it("review boundary: submitting one of two unresolved threads keeps the other available", async () => {
  const issue = decisionIssue();
  blockedIssues = [issue];
  timelinesByIssue[issue.id] = [
    { ...cardEntry("older", "pending-A"), created_at: "2026-11-01T00:00:00Z" },
    { ...cardEntry("newer", "pending-B"), created_at: "2026-11-02T00:00:00Z" },
  ];
  renderOverview();
  await screen.findByText(/pending-B/);
  await act(async () => {
    expect(await latestHostActions?.submitComment?.("answer", "key")).toBe(true);
  });
  expect(createComment).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByText(/pending-B/)).not.toBeInTheDocument());
  await screen.findByText(/pending-A/);
});

it("review boundary: empty project recovers cold start after tree retry", async () => {
  engineeringStages = [];
  getProjectWikiTree.mockRejectedValueOnce(new Error("temporary")).mockResolvedValue({
    pages: [],
    limits: { maxDepth: 6, maxPages: 500 },
  });
  renderOverview();
  await screen.findByText("无法加载页面树，请重试。");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByText("无法加载页面树，请重试。")).toBeNull());
  await waitFor(() => expect(document.querySelector("[data-engineering-cold-start]")).not.toBeNull());
});

it("review boundary: two revisions in one transaction straddling a page both remain reachable", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => {
    const page = index === 50 ? activityItems[1]! : activityItems[0]!;
    const seconds = 50 - Math.min(index, 49);
    return {
      ...page,
      number: 51 - index,
      createdAt: new Date(Date.UTC(2026, 10, 20, 0, 0, seconds)).toISOString(),
      changeSummary: "row " + index,
    };
  });
  getProjectWikiActivity.mockImplementation(async (
    _workspace: string,
    _project: string,
    { limit, before }: { limit: number; before?: string },
  ) => ({ items: rows.filter((row) => !before || row.createdAt < before).slice(0, limit) }));
  renderOverview("tab=activity");
  const activityRows = () => document.querySelectorAll("[data-activity-row]");
  await waitFor(() => expect(activityRows()).toHaveLength(50));
  fireEvent.click(screen.getByRole("button", { name: "加载更早版本" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "加载更早版本" })).toBeNull());
  expect(activityRows()).toHaveLength(51);
});
