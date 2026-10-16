// @vitest-environment jsdom

/**
 * OL-193 wiring: the issues header and the my-issues header hand the
 * agents-working chip a memoized summary scope built from the surface's
 * loaded issues (id → identifier). The chip is mocked to capture its props;
 * registration through the real chip lives in
 * workspace-agent-working-chip.tip-anchor.test.tsx.
 */

import { cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

const chipProps = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { user: { id: "user-1" }, isAuthenticated: true };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ user: { id: "user-1" }, isAuthenticated: true }) },
  ),
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

vi.mock("@multica/core/issues/stores/issues-scope-store", () => ({
  useIssuesScope: () => "all",
  useIssuesScopeStore: (selector: (state: unknown) => unknown) =>
    selector({ setScope: vi.fn() }),
}));

const viewStoreState = vi.hoisted(() => ({
  agentRunningFilter: false,
  toggleAgentRunningFilter: vi.fn(),
  viewMode: "list",
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
  cardProperties: {},
  tableGrouping: "none",
  tableHierarchy: true,
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

vi.mock("./workspace-agent-working-chip", () => ({
  WorkspaceAgentWorkingChip: (props: Record<string, unknown>) => {
    chipProps.current = props;
    return null;
  },
}));

// Siblings whose own behavior is not under test.
vi.mock("./view-bar", () => ({ ViewBar: () => null }));
vi.mock("./filter-chips-bar", () => ({ FilterChipsBar: () => null }));
vi.mock("./save-view-dialog", () => ({ SaveViewDialog: () => null }));

import { IssuesHeader } from "./issues-header";
import { MyIssuesHeader } from "../../my-issues/components/my-issues-header";

function makeIssue(id: string, identifier: string): Issue {
  return { id, identifier } as Issue;
}

const ISSUES = [makeIssue("i1", "OL-1"), makeIssue("i2", "OL-2")];

beforeEach(() => {
  cleanup();
  chipProps.current = undefined;
});

describe("IssuesHeader tip anchor scope (OL-193)", () => {
  it("passes the surface's loaded issues as the summary scope", () => {
    renderWithI18n(
      <IssuesHeader scopedIssues={ISSUES} workingAgents={undefined} tipAnchorScopeIssues={ISSUES} />,
    );
    expect(chipProps.current?.tipAnchorScope).toEqual({
      i1: "OL-1",
      i2: "OL-2",
    });
  });

  it("follows tipAnchorScopeIssues even when scopedIssues is empty (table mode)", () => {
    // Table mode pages rows through TableView's own query, so the header's
    // scopedIssues is EMPTY there — the scope must come from the surface's
    // per-view loaded-issues list instead.
    renderWithI18n(
      <IssuesHeader scopedIssues={[]} workingAgents={undefined} tipAnchorScopeIssues={ISSUES} />,
    );
    expect(chipProps.current?.tipAnchorScope).toEqual({
      i1: "OL-1",
      i2: "OL-2",
    });
  });

  it("keeps the scope referentially stable across re-renders", () => {
    const { rerender } = renderWithI18n(
      <IssuesHeader scopedIssues={ISSUES} workingAgents={undefined} tipAnchorScopeIssues={ISSUES} />,
    );
    const first = chipProps.current?.tipAnchorScope;
    rerender(<IssuesHeader scopedIssues={ISSUES} workingAgents={undefined} tipAnchorScopeIssues={ISSUES} />);
    expect(chipProps.current?.tipAnchorScope).toBe(first);
  });
});

describe("MyIssuesHeader tip anchor scope (OL-193)", () => {
  it("passes the surface's loaded issues as the summary scope", () => {
    renderWithI18n(
      <MyIssuesHeader
        allIssues={ISSUES}
        workingAgents={undefined}
        tipAnchorScopeIssues={ISSUES}
        scope="all"
        onScopeChange={() => {}}
        onTableFacetChange={() => {}}
      />,
    );
    expect(chipProps.current?.tipAnchorScope).toEqual({
      i1: "OL-1",
      i2: "OL-2",
    });
  });

  it("follows tipAnchorScopeIssues even when allIssues is empty (table mode)", () => {
    // Table mode pages rows through TableView's own query, so the header's
    // allIssues is EMPTY there — the scope must come from the surface's
    // per-view loaded-issues list instead.
    renderWithI18n(
      <MyIssuesHeader
        allIssues={[]}
        workingAgents={undefined}
        tipAnchorScopeIssues={ISSUES}
        scope="all"
        onScopeChange={() => {}}
        onTableFacetChange={() => {}}
      />,
    );
    expect(chipProps.current?.tipAnchorScope).toEqual({
      i1: "OL-1",
      i2: "OL-2",
    });
  });

  it("keeps the scope referentially stable across re-renders", () => {
    const props = {
      allIssues: ISSUES,
      workingAgents: undefined,
      tipAnchorScopeIssues: ISSUES,
      scope: "all" as const,
      onScopeChange: () => {},
      onTableFacetChange: () => {},
    };
    const { rerender } = renderWithI18n(<MyIssuesHeader {...props} />);
    const first = chipProps.current?.tipAnchorScope;
    rerender(<MyIssuesHeader {...props} />);
    expect(chipProps.current?.tipAnchorScope).toBe(first);
  });
});
