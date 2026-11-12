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
vi.mock("../../rich-content", () => ({ RichContent: ({ content }: { content: string }) => <div data-testid="decision-rich-content">{content}</div> }));

const OWNER = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";

let replace = vi.fn();
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
  } as unknown as ApiClient);
});

function renderOverview(search = "") {
  const adapter = {
    push: vi.fn(), replace, back: vi.fn(),
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
  it("shows the wiki summary card with the live page count", async () => {
    renderOverview();
    await screen.findByText("2 个页面", {}, { timeout: 3000 });
    expect(screen.getByTestId("wiki-enter")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-enter")).toHaveTextContent("进入基线 Wiki");
  });
  it("renders recent wiki activity with kind labels and deep-links rows into the wiki page", async () => {
    renderOverview();
    await screen.findByTestId("wiki-activity", {}, { timeout: 3000 });
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("新建页面");
    expect(bodyText).toContain("回滚");
    expect(bodyText).toContain("项目概览");
    fireEvent.click(screen.getByTestId("architecture"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("page=architecture"),
    ));
    // The click also switches the tab to the wiki (state, not just URL).
    expect(screen.getByRole("tab", { name: /基线 Wiki/ })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector("[data-wiki-shell]")).not.toBeNull();
  });

  it("no longer surfaces approval-candidate concepts anywhere on the overview", async () => {
    renderOverview();
    await screen.findByTestId("wiki-summary-card");
    // The retired review surface: no pending badge on the tab, no candidate rows.
    expect(screen.queryByTestId("candidate-todo")).not.toBeInTheDocument();
    expect(screen.queryByText(/待审|候选/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-engineering-top-chrome] .bg-destructive")).toBeNull();
    // No candidate queue: the decisions card only carries decision issues and
    // the stage-review entry (Stage 1 has no tasks, so review is pending).
    expect(document.querySelector("[data-review-todo]")).toBeNull();
    expect(document.querySelector("[data-no-pending-candidates]")).not.toBeNull();
    expect(screen.getByText("眼下没有要你处理的事，团队正在继续推进。")).toBeInTheDocument();
  });
});
