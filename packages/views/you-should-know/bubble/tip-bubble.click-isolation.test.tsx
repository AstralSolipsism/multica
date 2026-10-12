// @vitest-environment jsdom

/**
 * Click isolation (OL-194): the bubble is rendered by the page-level provider
 * and portaled to <body>, never as a React child of its anchor. Portal events
 * still bubble along the React tree, so a bubble rendered inside the anchor
 * would hand its clicks to whatever wraps the anchor. Each case mounts the
 * real anchor host, puts the bubble on it, clicks the bubble, and checks the
 * host did not react — with a control click proving the host does react to
 * clicks of its own.
 */

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTaskSnapshotKeys } from "@multica/core/agents";
import { issueKeys } from "@multica/core/issues/queries";
import type { AgentTask } from "@multica/core/types";
import { tipDisplayLedger } from "@multica/core/you-should-know";
import {
  createYskQueryClient,
  getBubble,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
  WS_ID,
} from "../../test/you-should-know";

const apiMock = vi.hoisted(() => ({
  listActiveTips: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkspaces: vi.fn(),
  getAgentTaskSnapshot: vi.fn(),
  listIssueWakeupSummaries: vi.fn(),
  listPausedWakeups: vi.fn(),
  listTasksByIssue: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

// Row indicator dependencies that read unrelated workspace data.
vi.mock("../../issues/components/wakeup-condition-names", () => ({
  useConditionNames: () => ({
    status: (key: string) => key,
    label: () => undefined,
    property: () => undefined,
    actor: (_type: string, id: string) => id,
  }),
}));
vi.mock("../../common/use-viewing-timezone", () => ({
  useViewingTimezone: () => "UTC",
}));
vi.mock("../../agents/components/agent-activity-hover-content", () => ({
  AgentActivityHoverContent: () => <div data-testid="activity-hover" />,
}));
// The header chip keeps its popover body mounted; its rows are not under test.
vi.mock("../../issues/components/execution-log-section", () => ({
  ActiveTaskRow: ({ task }: { task: AgentTask }) => (
    <div data-testid="active-task-row">{task.id}</div>
  ),
}));

import { AppLink } from "../../navigation";
import { IssueAgentActivityIndicator } from "../../issues/components/issue-agent-activity-indicator";
import { IssueAgentHeaderChip } from "../../issues/components/issue-agent-header-chip";
import { WorkspaceAgentWorkingChip } from "../../issues/components/workspace-agent-working-chip";

const RUNNING_TASK: AgentTask = {
  id: "task-1",
  agent_id: "agent-1",
  runtime_id: "runtime-1",
  issue_id: "issue-1",
  status: "running",
  priority: 0,
  dispatched_at: "2026-10-11T08:00:00Z",
  started_at: "2026-10-11T08:00:00Z",
  completed_at: null,
  result: null,
  error: null,
  created_at: "2026-10-11T08:00:00Z",
};

function queryClientWithRunningTask() {
  const client = createYskQueryClient();
  client.setQueryData(agentTaskSnapshotKeys.list(WS_ID), [RUNNING_TASK]);
  client.setQueryData(["issue-wakeup-summaries", WS_ID], []);
  client.setQueryData(["issue-wakeup-paused", WS_ID], []);
  client.setQueryData(issueKeys.tasks("issue-1"), [RUNNING_TASK]);
  return client;
}

function clickBubble() {
  const bubble = getBubble();
  expect(bubble).not.toBeNull();
  fireEvent.click(within(bubble!).getByRole("button"));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.listActiveTips.mockResolvedValue({
    tips: [makeTip({ issue_id: "issue-1", line: "The agent kept the old API" })],
  });
  apiMock.getAgentTaskSnapshot.mockResolvedValue([RUNNING_TASK]);
  apiMock.listIssueWakeupSummaries.mockResolvedValue([]);
  apiMock.listPausedWakeups.mockResolvedValue([]);
  apiMock.listTasksByIssue.mockResolvedValue([RUNNING_TASK]);
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bubble click isolation", () => {
  it("does not follow the issue row's link", async () => {
    // Same nesting as list-row.tsx: the activity indicator (with its hover
    // card trigger) inside the row's AppLink.
    const { navigation } = renderWithYsk(
      <div data-test-rect="80,300,600,36">
        <AppLink href="/acme/issues/issue-1">
          <span>OL-1</span>
          <IssueAgentActivityIndicator issueId="issue-1" tipAnchor />
        </AppLink>
      </div>,
      { queryClient: queryClientWithRunningTask() },
    );
    await settle();
    expect(getBubble()).toHaveAttribute("data-level", "row");

    clickBubble();
    expect(navigation.push).not.toHaveBeenCalled();

    // Control: the row link itself still navigates.
    fireEvent.click(screen.getByText("OL-1"));
    expect(navigation.push).toHaveBeenCalledWith("/acme/issues/issue-1");
  });

  it("does not toggle the header's agents-working filter", async () => {
    const onToggle = vi.fn();
    renderWithYsk(
      <div data-test-rect="900,20,160,28">
        <WorkspaceAgentWorkingChip
          value={false}
          onToggle={onToggle}
          agents={[{ id: "agent-1", running_task_count: 1 }]}
          tipAnchorScope={{ "issue-1": "OL-1" }}
        />
      </div>,
      { queryClient: queryClientWithRunningTask() },
    );
    await settle();
    expect(getBubble()).toHaveAttribute("data-level", "summary");
    expect(getBubble()!.textContent).toContain("OL-1");

    clickBubble();
    expect(onToggle).not.toHaveBeenCalled();

    // Control: clicking the chip toggles the filter.
    fireEvent.click(screen.getByRole("button", { pressed: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not open the detail header chip's popover", async () => {
    renderWithYsk(
      <div data-test-rect="1000,40,180,28">
        <IssueAgentHeaderChip issueId="issue-1" />
      </div>,
      { queryClient: queryClientWithRunningTask() },
    );
    await settle();
    expect(getBubble()).toHaveAttribute("data-level", "detail_header");
    const trigger = screen.getByRole("button", { name: "Agent agent-1 is working" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    clickBubble();
    await settle();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("data-popup-open");

    // Control: clicking the chip opens its popover.
    fireEvent.click(trigger);
    await settle();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
