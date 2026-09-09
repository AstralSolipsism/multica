// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";
import { RunDeliveryBadges } from "./run-delivery-badges";

const NAV_ADAPTER = {
  push: () => {},
  replace: () => {},
  back: () => {},
  pathname: "/ws/autopilots/ap-1",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path: string) => path,
};

type QueryResult = {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
};

const deliveriesRef = vi.hoisted(() => ({
  current: { data: { deliveries: [] }, isLoading: false, isError: false, isSuccess: true } as QueryResult,
}));
const membersRef = vi.hoisted(() => ({
  current: { data: [], isLoading: false, isError: false, isSuccess: true } as QueryResult,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.enabled === false) {
      return { data: undefined, isLoading: false, isError: false, isSuccess: false };
    }
    const key = JSON.stringify(opts.queryKey);
    if (key.includes('"detail"')) {
      return { data: undefined, isLoading: true, isError: false, isSuccess: false };
    }
    if (key.includes("members")) return membersRef.current;
    return deliveriesRef.current;
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  MESSAGE_DELIVERIES_PAGE_SIZE: 50,
  messageDeliveriesOptions: (_wsId: string, autopilotId: string) => ({
    queryKey: ["autopilots", "ws-1", "message-delivery", autopilotId, "deliveries", "all", 0],
  }),
  messageDeliveryOptions: (_wsId: string, autopilotId: string, deliveryId: string, options?: { enabled?: boolean }) => ({
    queryKey: ["autopilots", "ws-1", "message-delivery", autopilotId, "deliveries", "detail", deliveryId],
    enabled: options?.enabled ?? true,
  }),
  useRetryMessageDelivery: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function delivery(id: string, runId: string, status: string) {
  return {
    id,
    workspace_id: "ws-1",
    route_id: "route-1",
    route_revision: 1,
    autopilot_id: "ap-1",
    run_id: runId,
    source_kind: "run_only",
    status,
    attempts: 1,
    next_attempt_at: null,
    error_code: null,
    last_error: null,
    shard_total: 1,
    installation_id: "inst-1",
    target_key: "member:user-1",
    delivered_at: null,
    first_attempt_at: null,
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
  };
}

function renderBadges(runId = "run-1") {
  return renderWithI18n(
    <NavigationProvider value={NAV_ADAPTER}>
      <RunDeliveryBadges autopilotId="ap-1" runId={runId} canWrite />
    </NavigationProvider>,
  );
}

describe("RunDeliveryBadges", () => {
  beforeEach(() => {
    deliveriesRef.current = {
      data: {
        deliveries: [
          delivery("d-1", "run-1", "sent"),
          delivery("d-2", "run-1", "failed"),
          delivery("d-3", "run-2", "queued"),
        ],
      },
      isLoading: false,
      isError: false,
      isSuccess: true,
    };
  });

  afterEach(() => cleanup());

  it("renders the delivery statuses linked to this run only", () => {
    renderBadges("run-1");
    expect(screen.getByRole("button", { name: /view delivery: sent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view delivery: failed/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /view delivery: queued/i }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the run has no deliveries", () => {
    const { container } = renderBadges("run-404");
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the records query is forbidden (read-only)", () => {
    deliveriesRef.current = { data: undefined, isLoading: false, isError: true, isSuccess: false };
    const { container } = renderBadges("run-1");
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the delivery detail dialog from a badge", async () => {
    const user = userEvent.setup();
    renderBadges("run-1");
    await user.click(screen.getByRole("button", { name: /view delivery: failed/i }));
    expect(await screen.findByText("Delivery detail")).toBeInTheDocument();
  });
});
