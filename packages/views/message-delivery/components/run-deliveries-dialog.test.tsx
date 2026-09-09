// @vitest-environment jsdom

// R3 state display: unsupported and "no deliveries" are mutually exclusive,
// and pagination is withheld while the scope is unconfirmed.

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import { RunDeliveriesDialog } from "./run-deliveries-dialog";

const queryRef = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const fetchNextPageSpy = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => queryRef.current,
  useQuery: () => ({ data: undefined, isLoading: false }),
  infiniteQueryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageDeliveriesInfiniteOptions: (_wsId: string, apId: string, scope?: { runId?: string }) => ({
    queryKey: ["deliveries", apId, scope?.runId],
  }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

function delivery(id: string) {
  return {
    id,
    workspace_id: "ws-1",
    route_id: "route-1",
    route_revision: 1,
    autopilot_id: "ap-1",
    run_id: "run-1",
    source_kind: "run_only",
    status: "sent",
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

function renderDialog() {
  return renderWithI18n(
    <RunDeliveriesDialog
      open
      onOpenChange={() => {}}
      autopilotId="ap-1"
      runId="run-1"
      onOpenDelivery={() => {}}
    />,
  );
}

describe("RunDeliveriesDialog scope display", () => {
  afterEach(() => cleanup());

  it("confirmed empty scope says 'no deliveries'", () => {
    queryRef.current = {
      data: { pages: [{ deliveries: [], applied_run_id: "run-1" }] },
      isLoading: false,
      hasNextPage: false,
    };
    renderDialog();
    expect(screen.getByText(/no delivery records yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't supported by this server/i)).not.toBeInTheDocument();
  });

  it("unconfirmed empty scope says unsupported — never both", () => {
    queryRef.current = {
      data: { pages: [{ deliveries: [], applied_run_id: null }] },
      isLoading: false,
      hasNextPage: false,
    };
    renderDialog();
    expect(screen.getByText(/isn't supported by this server/i)).toBeInTheDocument();
    expect(screen.queryByText(/no delivery records yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("keeps the confirmed prefix rows and notes the unsupported tail", () => {
    queryRef.current = {
      data: {
        pages: [
          { deliveries: [delivery("d-1")], applied_run_id: "run-1" },
          { deliveries: [delivery("d-other")], applied_run_id: null },
        ],
      },
      isLoading: false,
      hasNextPage: true,
      fetchNextPage: fetchNextPageSpy,
    };
    renderDialog();
    // The confirmed row stays; the other run's row does not; the note shows;
    // load-more is withheld while unconfirmed.
    expect(screen.getByText("member:user-1")).toBeInTheDocument();
    expect(screen.getAllByText("member:user-1")).toHaveLength(1);
    expect(screen.getByText(/isn't supported by this server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("normal multi-page scope still pages", () => {
    queryRef.current = {
      data: {
        pages: [
          { deliveries: [delivery("d-1")], applied_run_id: "run-1" },
          { deliveries: [delivery("d-2")], applied_run_id: "run-1" },
        ],
      },
      isLoading: false,
      hasNextPage: true,
      fetchNextPage: fetchNextPageSpy,
    };
    renderDialog();
    expect(screen.getAllByText("member:user-1")).toHaveLength(2);
    expect(screen.queryByText(/isn't supported by this server/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
  });
});
