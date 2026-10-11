// @vitest-environment jsdom

/**
 * OL-193 wiring: table rows opt their IssueAgentActivityIndicator into
 * row-level tip anchoring. Rendered through the real TableView with the
 * indicator mocked to capture its props.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import type { Issue, IssueTableQuerySpec } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { IssueSurfaceSelectionProvider } from "../surface/selection-context";
import type { IssueSurfaceSelection } from "../surface/selection-context";
import type { ChildProgress } from "./list-row";
import { TableView } from "./table-view";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

// jsdom has no layout, so the real row virtualizer sees a 0-height viewport
// and renders nothing. Render every row inline instead (mirrors the mock in
// table-view-editing.test.tsx).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey?: (index: number) => unknown;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey?.(index) ?? index,
        start: index * 41,
        end: (index + 1) * 41,
        size: 41,
        lane: 0,
      })),
    getTotalSize: () => options.count * 41,
    measureElement: () => {},
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Someone" }),
  buildActorNameResolver: () => () => "Someone",
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        user: { id: "user-1", email: "t@t.co", name: "Tester" },
        isAuthenticated: true,
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ user: { id: "user-1" }, isAuthenticated: true }) },
  ),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({
    push: vi.fn(),
    getShareableUrl: (path: string) => `https://app.example${path}`,
    pathname: "/",
  }),
  useIntentNavigate: () => () => {},
}));

vi.mock("@multica/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/paths")>(
    "@multica/core/paths",
  );
  return {
    ...actual,
    useWorkspacePaths: () => actual.paths.workspace("test"),
  };
});

const indicatorCalls = vi.hoisted(() => ({
  props: [] as Record<string, unknown>[],
}));

vi.mock("./issue-agent-activity-indicator", () => ({
  IssueAgentActivityIndicator: (props: Record<string, unknown>) => {
    indicatorCalls.props.push(props);
    return null;
  },
}));

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function makeIssue(id: string): Issue {
  return {
    id,
    workspace_id: "ws-1",
    number: 1,
    identifier: `MUL-${id}`,
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "member-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    stage: null,
    start_date: null,
    due_date: null,
    labels: [],
    metadata: {},
    properties: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as Issue;
}

const selection: IssueSurfaceSelection = {
  selectedIds: new Set<string>(),
  toggle: () => {},
  select: () => {},
  deselect: () => {},
  clear: () => {},
};

const serverQuery: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "position", direction: "asc" },
};

const serverIssues = [makeIssue("a"), makeIssue("b")];

let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", ObserverStub);
  vi.stubGlobal("ResizeObserver", ObserverStub);
  indicatorCalls.props = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  setApiInstance({
    listProperties: async () => ({ properties: [] }),
    listMembers: async () => [],
    listAgents: async () => [],
    listSquads: async () => [],
    getAssigneeFrequency: async () => [],
    listIssueStatuses: async () => ({ statuses: [] }),
    listIssueTableRows: async () => ({
      query_fingerprint: "test",
      group_key: null,
      parent_id: null,
      total: serverIssues.length,
      rows: serverIssues.map((issue) => ({ issue, direct_child_count: 0 })),
      branch_total: serverIssues.length,
      next_cursor: null,
    }),
  } as unknown as ApiClient);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TableView tip anchor wiring (OL-193)", () => {
  it("opts each row's activity indicator into row-level tip anchoring", async () => {
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <ViewStoreProvider store={getIssueSurfaceViewStore("ysk-wiring-test")}>
          <IssueSurfaceSelectionProvider selection={selection}>
            <TableView
              serverQuery={serverQuery}
              childProgressMap={new Map<string, ChildProgress>()}
              search=""
              onSearchChange={() => {}}
              onLoadedIssuesChange={() => {}}
              onCreateIssue={() => {}}
              exportIssues={() => Promise.resolve(serverIssues)}
              resolveExportLookups={() =>
                Promise.resolve({
                  projectMap: new Map(),
                  childProgressMap: new Map(),
                })
              }
            />
          </IssueSurfaceSelectionProvider>
        </ViewStoreProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("MUL-a");
    const byIssue = new Map(
      indicatorCalls.props.map((props) => [props.issueId, props]),
    );
    expect(byIssue.get("a")).toMatchObject({ tipAnchor: true });
    expect(byIssue.get("b")).toMatchObject({ tipAnchor: true });
  });
});
