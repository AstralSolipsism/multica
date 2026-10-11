// @vitest-environment jsdom

/**
 * Row-level tip anchor registration (OL-193): IssueAgentActivityIndicator
 * passes a `row` descriptor down to the REAL AgentAvatarStack while a task
 * is running, and nothing at all when only queued or when the surface did
 * not opt in via the `tipAnchor` prop.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../locales/en/issues.json";
import type { AgentTask } from "@multica/core/types";
import {
  createTipAnchorRegistry,
  type TipAnchorRegistry,
} from "@multica/core/you-should-know/anchors";
import { TipAnchorRegistryProvider } from "../../you-should-know/anchors/tip-anchor-context";

const mockState = vi.hoisted(() => ({
  snapshot: [] as unknown[],
  summaries: [] as unknown[],
  paused: [] as unknown[],
}));

vi.mock("./wakeup-condition-names", () => ({
  useConditionNames: () => ({ status: (key: string) => key, label: () => undefined, property: () => undefined, actor: (_type: string, id: string) => id }),
}));
vi.mock("../../common/use-viewing-timezone", () => ({
  useViewingTimezone: () => "UTC",
}));
vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/agents", () => ({
  agentTaskSnapshotOptions: (wsId: string) => ({
    queryKey: ["agents", "task-snapshot", wsId],
  }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../agents/components/agent-activity-hover-content", () => ({
  AgentActivityHoverContent: () => <div data-testid="activity-hover" />,
}));

vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (
      selector: (strings: typeof en) => string,
      params: Record<string, unknown> = {},
    ) =>
      selector(en).replace(/{{(\w+)}}/g, (_, key: string) =>
        String(params[key] ?? ""),
      ),
  }),
  useLocale: () => "en",
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: (opts: {
      queryKey?: readonly unknown[];
      select?: (data: unknown) => unknown;
    }) => {
      if (opts.queryKey?.[1] === "task-snapshot") {
        return {
          data: opts.select
            ? opts.select(mockState.snapshot)
            : mockState.snapshot,
        };
      }
      if (opts.queryKey?.[0] === "issue-wakeup-paused")
        return {
          data: opts.select ? opts.select(mockState.paused) : mockState.paused,
        };
      if (opts.queryKey?.[0] === "issue-wakeup-summaries")
        return {
          data: opts.select
            ? opts.select(mockState.summaries)
            : mockState.summaries,
        };
      return { data: undefined };
    },
  };
});

import { IssueAgentActivityIndicator } from "./issue-agent-activity-indicator";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-06-08T08:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-06-08T08:00:00Z",
    ...overrides,
  };
}

let registry: TipAnchorRegistry;

function renderIndicator(ui: React.ReactElement) {
  return render(
    <TipAnchorRegistryProvider registry={registry}>
      {ui}
    </TipAnchorRegistryProvider>,
  );
}

function registeredDescriptors() {
  return Object.values(registry.getState().anchors).map((a) => a.descriptor);
}

beforeEach(() => {
  cleanup();
  registry = createTipAnchorRegistry();
  mockState.snapshot = [makeTask()];
  mockState.summaries = [];
  mockState.paused = [];
});

describe("IssueAgentActivityIndicator tip anchor", () => {
  it("registers a row-level anchor while a task is running", () => {
    renderIndicator(<IssueAgentActivityIndicator issueId="issue-1" tipAnchor />);
    expect(registeredDescriptors()).toEqual([{ level: "row", issueId: "issue-1" }]);
  });

  it("does not register when only queued (no running task)", () => {
    mockState.snapshot = [makeTask({ status: "queued" })];
    renderIndicator(<IssueAgentActivityIndicator issueId="issue-1" tipAnchor />);
    // The badge renders (queued state), but no anchor registers.
    expect(screen.getByText(en.agent_activity.status_queued)).toBeInTheDocument();
    expect(registeredDescriptors()).toEqual([]);
  });

  it("does not register without the tipAnchor prop, even when running", () => {
    renderIndicator(<IssueAgentActivityIndicator issueId="issue-1" />);
    expect(registeredDescriptors()).toEqual([]);
  });

  it("does not register for another issue's running task", () => {
    mockState.snapshot = [makeTask({ issue_id: "issue-2" })];
    renderIndicator(<IssueAgentActivityIndicator issueId="issue-1" tipAnchor />);
    expect(registeredDescriptors()).toEqual([]);
  });

  it("is inert without a provider: renders the badge, registers nothing, no crash", () => {
    render(<IssueAgentActivityIndicator issueId="issue-1" tipAnchor hoverCard={false} />);
    // ShimmerText renders the label twice (one aria-hidden copy).
    expect(
      screen.getAllByText(en.agent_activity.status_running).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("tip-anchor-dot")).not.toBeInTheDocument();
  });
});
