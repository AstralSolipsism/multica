import { act, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { useHtmlBlockHostActions, type HtmlBlockHostActions } from "../../editor/html-block-host-actions";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { IssuePeekActionsContext, type IssuePeekActions } from "../../issues/surface/peek-context";
import { EngineeringDecisions } from "./engineering-decisions";

const { createComment, openPeek } = vi.hoisted(() => ({ createComment: vi.fn(), openPeek: vi.fn() }));
let hostActions: HtmlBlockHostActions | null = null;

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/issues/mutations", () => ({
  useCreateComment: () => ({ mutateAsync: createComment }),
}));
vi.mock("../../rich-content", () => ({
  RichContent: ({ content }: { content: string }) => {
    hostActions = useHtmlBlockHostActions();
    return <div data-testid="decision-rich-content">{content}</div>;
  },
}));

const issue = {
  id: "issue-1",
  identifier: "OL-1",
  title: "Choose the delivery contract",
  status: "blocked",
  assignee_type: "squad",
  assignee_id: "squad-1",
} as Issue;
const comment = {
  id: "comment-1",
  type: "comment",
  actor_type: "member",
  actor_id: "member-1",
  content: "```html src=\"decision.html\" title=\"决策：OL-1\"\ncard",
  parent_id: null,
  resolved_at: null,
  deleted_at: null,
  created_at: "2026-11-01T00:00:00Z",
  attachments: [],
} as TimelineEntry;
const navigation = {
  push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/acme/projects/p/engineering",
  searchParams: new URLSearchParams(), hash: "", openInNewTab: vi.fn(), getShareableUrl: (path: string) => path,
} as unknown as NavigationAdapter;
const peek = {
  open: openPeek, toggle: vi.fn(), close: vi.fn(), publishColumns: vi.fn(),
} satisfies IssuePeekActions;

function renderDecisions() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={navigation}>
        <IssuePeekActionsContext.Provider value={peek}>
          <EngineeringDecisions
            workspaceSlug="acme"
            projectId="project-1"
            issues={[issue]}
            timelines={{ [issue.id]: { comment, loading: false, error: false } }}
            reviewStage={null}
            onReview={vi.fn()}
          />
        </IssuePeekActionsContext.Provider>
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

describe("EngineeringDecisions host bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostActions = null;
    useCommentDraftStore.setState({ drafts: {} });
  });

  it("replies to the selected card thread and advances the queue after success", async () => {
    createComment.mockResolvedValue({ id: "reply-1" });
    renderDecisions();
    await screen.findByTestId("decision-rich-content");

    let result = false;
    await act(async () => {
      result = await hostActions?.submitComment?.("采用方案 A", "card-key") ?? false;
    });
    expect(result).toBe(true);
    expect(createComment).toHaveBeenCalledWith({ content: "采用方案 A", parentId: "comment-1" });
    await waitFor(() => expect(screen.queryByTestId("decision-rich-content")).not.toBeInTheDocument());
  });

  it("fills the shared draft and opens the existing peek with a focus request", async () => {
    renderDecisions();
    await screen.findByTestId("decision-rich-content");

    await act(async () => {
      expect(await hostActions?.fillComment?.("采用方案 A\n补充原因")).toBe(true);
    });
    expect(useCommentDraftStore.getState().getDraft("new:issue-1")).toBe("采用方案 A\n补充原因");
    expect(openPeek).toHaveBeenCalledWith("issue-1", { commentDraft: "采用方案 A\n补充原因" });
  });
});
