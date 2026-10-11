// @vitest-environment jsdom

/**
 * OL-193 wiring regression: in table mode MyIssuesPage must feed the
 * agents-working chip the scope the surface computed for the current view
 * (the table's loaded rows), NOT controller.surfaceIssues — which is empty
 * in table mode. The IssueSurface is stubbed to hand the page a controlled
 * render context; the chip is mocked to capture its props.
 */

import { cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";

const chipProps = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

// A controlled surface: issues the CURRENT view loaded (one table row) vs
// the controller's surfaceIssues (empty, as in table mode). The page must
// forward the former to the header's tipAnchorScopeIssues.
const surfaceContext = vi.hoisted(() => ({
  controller: {
    surfaceIssues: [],
    workingAgents: undefined,
    isRefreshing: false,
    facetCountsExact: true,
    tableFacetCounts: undefined,
    setActiveTableFacet: () => {},
  },
  issues: [],
  summaryScopeIssues: [{ id: "t1", identifier: "MUL-t1" }],
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
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

vi.mock("../../issues/surface/issue-surface", () => ({
  IssueSurface: ({
    renderHeader,
  }: {
    renderHeader: (context: typeof surfaceContext) => React.ReactNode;
  }) => <>{renderHeader(surfaceContext)}</>,
}));

vi.mock("@multica/core/issue-views/use-active-view", () => ({
  useActiveIssueView: () => ({
    activeView: null,
    views: [],
    viewsReady: true,
    setActive: vi.fn(),
    missing: false,
  }),
}));

const viewStoreState = vi.hoisted(() => ({
  agentRunningFilter: false,
  toggleAgentRunningFilter: vi.fn(),
  viewMode: "table",
  statusFilters: [],
  priorityFilters: [],
  assigneeFilters: [],
  includeNoAssignee: false,
  creatorFilters: [],
  projectFilters: [],
  includeNoProject: false,
  projectStatusFilters: [],
  labelFilters: [],
  propertyFilters: {},
  cardPropertyIds: [],
  sortBy: "position",
  sortDirection: "asc",
  grouping: "status",
  swimlaneGrouping: "parent",
  dagDirection: "LR",
  cardProperties: {},
  tableGrouping: "none",
  tableHierarchy: true,
  tableColumns: [],
  showSubIssues: true,
}));

vi.mock("@multica/core/issues/stores/view-store-context", () => ({
  useViewStore: (selector: (state: unknown) => unknown) =>
    selector(viewStoreState),
  useViewStoreApi: () => ({ getState: () => viewStoreState }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
}));

vi.mock("../../issues/components/workspace-agent-working-chip", () => ({
  WorkspaceAgentWorkingChip: (props: Record<string, unknown>) => {
    chipProps.current = props;
    return null;
  },
}));

// Header siblings whose own behavior is not under test.
vi.mock("../../issues/components/view-bar", () => ({ ViewBar: () => null }));
vi.mock("../../issues/components/filter-chips-bar", () => ({
  FilterChipsBar: () => null,
}));
vi.mock("../../issues/components/save-view-dialog", () => ({
  SaveViewDialog: () => null,
}));

import { MyIssuesPage } from "./my-issues-page";

beforeEach(() => {
  cleanup();
  chipProps.current = undefined;
});

describe("MyIssuesPage tip anchor scope (OL-193)", () => {
  it("forwards the surface's per-view loaded issues to the chip, not the empty surfaceIssues", () => {
    renderWithI18n(<MyIssuesPage />);
    expect(chipProps.current?.tipAnchorScope).toEqual({ t1: "MUL-t1" });
  });
});
