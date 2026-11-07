// @vitest-environment jsdom

/** OL-193: IssueViewHeader memoizes the summary scope handed to the chip. */

import { cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@multica/core/types";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { getIssueSurfaceViewStore } from "@multica/core/issues/stores/surface-view-store";
import { renderWithI18n } from "../../test/i18n";
import type { IssueSurfaceController } from "../surface/use-issue-surface-controller";
import { IssueViewHeader } from "../../issue-views/view-header";

const chipProps = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return { ...actual, useWorkspacePaths: () => actual.paths.workspace("acme") };
});

vi.mock("@multica/core/issue-views/use-active-view", () => ({
  useActiveIssueView: () => ({
    activeView: null,
    setActive: vi.fn(),
    missing: false,
  }),
}));

vi.mock("../../my-issues/use-my-issues-scope", () => ({
  useMyIssuesScope: () => "assigned",
}));

vi.mock("../../issue-views/use-view-actions", () => ({
  useIssueViewActions: () => ({
    sidebar: { isStarred: () => false, star: vi.fn(), unstar: vi.fn() },
    canManage: () => true,
    copyLink: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
  }),
}));

vi.mock("../components/filter-chips-bar", () => ({
  useFilterChips: () => ({ chips: [] }),
}));

vi.mock("../components/issues-header", () => ({
  IssueDisplayControls: () => null,
  IssueFilterMenu: () => null,
}));

vi.mock("./workspace-agent-working-chip", () => ({
  WorkspaceAgentWorkingChip: (props: Record<string, unknown>) => {
    chipProps.current = props;
    return null;
  },
}));

function makeIssue(id: string, identifier: string): Issue {
  return { id, identifier } as Issue;
}

const ISSUES = [makeIssue("i1", "OL-1"), makeIssue("i2", "OL-2")];
const CONTROLLER = {
  hasActiveFilters: false,
  isRefreshing: false,
  surfaceIssues: [],
  workingAgents: [{ id: "agent-1" }],
  allowGantt: false,
  allowDag: false,
  facetCountsExact: false,
  openCreateIssue: vi.fn(),
} as unknown as IssueSurfaceController;

function renderHeader(base: { kind: "workspace" } | { kind: "my" } = { kind: "workspace" }) {
  return renderWithI18n(
    <ViewStoreProvider store={getIssueSurfaceViewStore("tip-anchor-header")}>
      <IssueViewHeader
        controller={CONTROLLER}
        base={base}
        tipAnchorScopeIssues={ISSUES}
      />
    </ViewStoreProvider>,
  );
}

beforeEach(() => {
  cleanup();
  chipProps.current = undefined;
});

describe("IssueViewHeader tip anchor scope (OL-193)", () => {
  it.each([{ kind: "workspace" }, { kind: "my" }] as const)(
    "passes the current view's loaded issues to the $kind header chip",
    (base) => {
      renderHeader(base);
      expect(chipProps.current?.tipAnchorScope).toEqual({
        i1: "OL-1",
        i2: "OL-2",
      });
    },
  );

  it("keeps the scope referentially stable across re-renders", () => {
    const { rerender } = renderHeader();
    const first = chipProps.current?.tipAnchorScope;
    rerender(
      <ViewStoreProvider store={getIssueSurfaceViewStore("tip-anchor-header")}>
        <IssueViewHeader
          controller={CONTROLLER}
          base={{ kind: "workspace" }}
          tipAnchorScopeIssues={ISSUES}
        />
      </ViewStoreProvider>,
    );
    expect(chipProps.current?.tipAnchorScope).toBe(first);
  });
});
