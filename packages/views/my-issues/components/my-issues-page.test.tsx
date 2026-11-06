// @vitest-environment jsdom

/** OL-193: table mode forwards the table's loaded rows, not surfaceIssues. */

import { cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";

const headerProps = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

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

vi.mock("../use-my-issues-scope", () => ({
  useMyIssuesScope: () => "assigned",
}));

vi.mock("../../issues/surface/issue-surface", () => ({
  IssueSurface: ({
    renderHeader,
  }: {
    renderHeader: (context: typeof surfaceContext) => React.ReactNode;
  }) => <>{renderHeader(surfaceContext)}</>,
}));

vi.mock("../../issue-views/view-header", () => ({
  IssueViewHeader: (props: Record<string, unknown>) => {
    headerProps.current = props;
    return null;
  },
}));

import { MyIssuesPage } from "./my-issues-page";

beforeEach(() => {
  cleanup();
  headerProps.current = undefined;
});

describe("MyIssuesPage tip anchor scope (OL-193)", () => {
  it("forwards the surface's per-view loaded issues to IssueViewHeader", () => {
    renderWithI18n(<MyIssuesPage />);
    expect(headerProps.current?.tipAnchorScopeIssues).toBe(surfaceContext.summaryScopeIssues);
  });
});
