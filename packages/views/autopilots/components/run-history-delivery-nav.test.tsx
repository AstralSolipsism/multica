// @vitest-environment jsdom

// R5 evidence: run rows render inside a REAL AppLink (create_issue mode) and
// a plain row (run_only mode), with the delivery dialogs hoisted to the run
// history host. Every interaction inside the detail dialog — retry, the
// uncertain verify confirm, closing — must NOT bubble into the row's task
// navigation, while the task link itself still works.

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation";
import { RunHistoryList } from "./autopilot-detail-page";

const pushSpy = vi.hoisted(() => vi.fn());
const retrySpy = vi.hoisted(() => vi.fn());

const DELIVERIES: Record<string, unknown> = {
  "run-issue": {
    id: "d-issue",
    workspace_id: "ws-1",
    route_id: "route-1",
    route_revision: 1,
    autopilot_id: "ap-1",
    run_id: "run-issue",
    source_kind: "create_issue",
    status: "failed",
    attempts: 2,
    next_attempt_at: null,
    error_code: "send_rejected",
    last_error: "boom",
    shard_total: 1,
    installation_id: "inst-1",
    target_key: "member:user-1",
    delivered_at: null,
    first_attempt_at: "2026-09-08T02:30:01Z",
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
  },
  "run-plain": {
    id: "d-plain",
    workspace_id: "ws-1",
    route_id: "route-1",
    route_revision: 1,
    autopilot_id: "ap-1",
    run_id: "run-plain",
    source_kind: "run_only",
    status: "uncertain",
    attempts: 1,
    next_attempt_at: null,
    error_code: "send_ambiguous",
    last_error: "response lost",
    shard_total: 1,
    installation_id: "inst-1",
    target_key: "group:oc_1",
    delivered_at: null,
    first_attempt_at: "2026-09-08T02:30:01Z",
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
  },
};

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (opts: { queryKey: unknown[] }) => {
    const runId = opts.queryKey[2] as string;
    const row = DELIVERIES[runId];
    return {
      data: { pages: [{ deliveries: row ? [row] : [], applied_run_id: runId }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key.includes('"detail"')) {
      const id = (opts.queryKey as unknown[]).at(-1) as string;
      const row = Object.values(DELIVERIES).find(
        (d) => (d as { id: string }).id === id,
      );
      return {
        data: {
          delivery: row,
          content_snapshot: { text: "report", summary: "s", has_output: true },
          target_snapshot: null,
          source_ref: null,
          receipts: [],
        },
        isLoading: false,
        isError: false,
      };
    }
    if (key.includes("members")) {
      return { data: [{ user_id: "user-1", name: "Alice", email: "a@b.c" }], isLoading: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  infiniteQueryOptions: <T,>(opts: T) => opts,
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageDeliveriesInfiniteOptions: (_wsId: string, autopilotId: string, scope?: { runId?: string }) => ({
    queryKey: ["deliveries", autopilotId, scope?.runId ?? "any"],
  }),
  messageDeliveryOptions: (_wsId: string, autopilotId: string, deliveryId: string) => ({
    queryKey: ["deliveries", autopilotId, "detail", deliveryId],
  }),
  messageDeliveryKeys: {
    delivery: (_wsId: string, autopilotId: string, deliveryId: string) => [
      "deliveries",
      autopilotId,
      "detail",
      deliveryId,
    ],
  },
  useRetryMessageDelivery: () => ({
    mutate: retrySpy,
    mutateAsync: retrySpy,
    isPending: false,
  }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Agent" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const NAV: NavigationAdapter = {
  push: pushSpy,
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/ws/autopilots/ap-1",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (p) => p,
};

const RUNS: import("@multica/core/types").AutopilotRun[] = [
  {
    id: "run-issue",
    autopilot_id: "ap-1",
    trigger_id: null,
    source: "schedule",
    status: "issue_created",
    issue_id: "issue-1",
    task_id: null,
    triggered_at: "2026-09-08T02:00:00Z",
    completed_at: "2026-09-08T02:01:00Z",
    failure_reason: null,
    trigger_payload: null,
    result: null,
    created_at: "2026-09-08T02:00:00Z",
  },
  {
    id: "run-plain",
    autopilot_id: "ap-1",
    trigger_id: null,
    source: "schedule",
    status: "completed",
    issue_id: null,
    task_id: null,
    triggered_at: "2026-09-08T03:00:00Z",
    completed_at: "2026-09-08T03:01:00Z",
    failure_reason: null,
    trigger_payload: null,
    result: null,
    created_at: "2026-09-08T03:00:00Z",
  },
];

function renderList() {
  return renderWithI18n(
    <NavigationProvider value={NAV}>
      <RunHistoryList runs={RUNS} agentId="agent-1" agentName="Agent" canWrite />
    </NavigationProvider>,
  );
}

describe("Run history delivery dialogs never navigate the outer task link (R5)", () => {
  afterEach(() => {
    cleanup();
    pushSpy.mockReset();
    retrySpy.mockReset();
  });

  it("create_issue row: badge → detail → retry → close, all without navigation", async () => {
    const user = userEvent.setup();
    renderList();

    // Control: the task link itself still navigates.
    await user.click(screen.getByRole("link", { name: /issue created/i }));
    expect(pushSpy).toHaveBeenCalledWith("/ws/issues/issue-1");
    pushSpy.mockReset();

    await user.click(screen.getByRole("button", { name: /view delivery: failed/i }));
    expect(await screen.findByText("Delivery detail")).toBeInTheDocument();
    expect(pushSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("run_only row: badge → detail → uncertain verify confirm, no navigation", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: /view delivery: uncertain/i }));
    expect(await screen.findByText("Delivery detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByText(/verify before retrying/i)).toBeInTheDocument();
    expect(retrySpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /checked — retry/i }));
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
