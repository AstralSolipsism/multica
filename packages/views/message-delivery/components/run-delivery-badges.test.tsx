// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { RunDeliveryBadges } from "./run-delivery-badges";

type InfiniteResult = {
  data?: { pages: { deliveries: unknown[]; applied_run_id: string | null }[] };
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};

const queryRef = vi.hoisted(() => ({ current: undefined as InfiniteResult | undefined }));

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () =>
    queryRef.current ?? {
      data: undefined,
      isLoading: true,
      isError: false,
      hasNextPage: false,
    },
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  infiniteQueryOptions: <T,>(opts: T) => opts,
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageDeliveriesInfiniteOptions: (_wsId: string, autopilotId: string, scope?: { runId?: string }) => ({
    queryKey: ["deliveries", autopilotId, scope?.runId],
  }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

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

function withRows(runId: string, rows: ReturnType<typeof delivery>[], applied?: string | null) {
  queryRef.current = {
    data: {
      pages: [{ deliveries: rows, applied_run_id: applied === undefined ? runId : applied }],
    },
    isLoading: false,
    isError: false,
  };
}

const onOpenDelivery = vi.fn();
const onOpenRunList = vi.fn();

function renderBadges(runId = "run-1") {
  return renderWithI18n(
    <RunDeliveryBadges
      autopilotId="ap-1"
      runId={runId}
      onOpenDelivery={onOpenDelivery}
      onOpenRunList={onOpenRunList}
    />,
  );
}

describe("RunDeliveryBadges", () => {
  beforeEach(() => {
    queryRef.current = undefined;
    onOpenDelivery.mockReset();
    onOpenRunList.mockReset();
  });

  afterEach(() => cleanup());

  it("renders only this run's delivery statuses and opens them via callback", async () => {
    withRows("run-1", [delivery("d-1", "run-1", "sent"), delivery("d-2", "run-1", "failed")]);
    const user = userEvent.setup();
    renderBadges("run-1");
    const sent = screen.getByRole("button", { name: /view delivery: sent/i });
    const failed = screen.getByRole("button", { name: /view delivery: failed/i });
    expect(sent).toBeInTheDocument();
    expect(failed).toBeInTheDocument();
    await user.click(failed);
    expect(onOpenDelivery).toHaveBeenCalledTimes(1);
    expect(onOpenDelivery.mock.calls[0]?.[0].id).toBe("d-2");
  });

  it("offers the per-run list from the overflow affordance", async () => {
    withRows("run-1", [
      delivery("d-1", "run-1", "sent"),
      delivery("d-2", "run-1", "failed"),
      delivery("d-3", "run-1", "queued"),
      delivery("d-4", "run-1", "cancelled"),
      delivery("d-5", "run-1", "suppressed"),
    ]);
    const user = userEvent.setup();
    renderBadges("run-1");
    await user.click(screen.getByRole("button", { name: /all deliveries for this run/i }));
    expect(onOpenRunList).toHaveBeenCalledWith("run-1");
  });

  it("renders nothing when the run genuinely has no deliveries (echo confirms)", () => {
    withRows("run-1", [], "run-1");
    const { container } = renderBadges("run-1");
    expect(container).toBeEmptyDOMElement();
  });

  it("states unsupported instead of 'no deliveries' when the server ignores run_id", () => {
    // A pre-R3 server answers 200 but its response lacks a matching
    // applied_run_id echo — the filter was NOT applied.
    withRows("run-1", [], null);
    renderBadges("run-1");
    expect(screen.getByText(/isn't supported by this server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view delivery/i })).not.toBeInTheDocument();
  });

  it("stays silent on a real 403 (read-only)", () => {
    queryRef.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError("forbidden", 403, "Forbidden"),
    };
    const { container } = renderBadges("run-1");
    expect(container).toBeEmptyDOMElement();
  });
});
