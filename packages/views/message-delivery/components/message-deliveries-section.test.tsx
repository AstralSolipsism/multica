// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";

const NAV_ADAPTER = {
  push: () => {},
  replace: () => {},
  back: () => {},
  pathname: "/ws/autopilots/ap-1",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (path: string) => path,
};

import { MessageDeliveriesSection } from "./message-deliveries-section";

type QueryResult = {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
};

const ok = vi.hoisted(
  () =>
    (data: unknown): QueryResult => ({
      data,
      isLoading: false,
      isError: false,
      isSuccess: true,
    }),
);

const deliveriesRef = vi.hoisted(() => ({ current: ok({ deliveries: [], limit: 50, offset: 0 }) as QueryResult }));
const detailRef = vi.hoisted(() => ({ current: undefined as QueryResult | undefined }));
const mockRetry = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.enabled === false) {
      return { data: undefined, isLoading: false, isError: false, isSuccess: false };
    }
    const key = JSON.stringify(opts.queryKey);
    if (key.includes('"detail"')) {
      return (
        detailRef.current ?? {
          data: undefined,
          isLoading: true,
          isError: false,
          isSuccess: false,
        }
      );
    }
    if (key.includes("deliveries")) return deliveriesRef.current;
    return { data: undefined, isLoading: false, isError: false, isSuccess: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageDeliveriesOptions: (_wsId: string, autopilotId: string, params?: { status?: string }) => ({
    queryKey: ["message-delivery", "ws-1", "autopilot", autopilotId, "deliveries", params?.status ?? "all"],
  }),
  messageDeliveryOptions: (_wsId: string, autopilotId: string, deliveryId: string, options?: { enabled?: boolean }) => ({
    queryKey: ["message-delivery", "ws-1", "autopilot", autopilotId, "deliveries", "detail", deliveryId],
    enabled: options?.enabled ?? true,
  }),
  useRetryMessageDelivery: () => ({
    mutate: mockRetry,
    mutateAsync: mockRetry,
    isPending: false,
  }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function delivery(overrides: Record<string, unknown>) {
  return {
    id: "d-1",
    workspace_id: "ws-1",
    route_id: "route-1",
    route_revision: 3,
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
    delivered_at: "2026-09-08T02:30:02Z",
    first_attempt_at: "2026-09-08T02:30:01Z",
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
    ...overrides,
  };
}

function renderSection(canWrite = true) {
  return renderWithI18n(
    <NavigationProvider value={NAV_ADAPTER}>
      <MessageDeliveriesSection autopilotId="ap-1" canWrite={canWrite} />
    </NavigationProvider>,
  );
}

describe("MessageDeliveriesSection", () => {
  beforeEach(() => {
    deliveriesRef.current = ok({ deliveries: [], limit: 50, offset: 0 });
    detailRef.current = undefined;
    mockRetry.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders rows with localized status, source kind and target key", () => {
    deliveriesRef.current = ok({
      deliveries: [
        delivery({ id: "d-1", status: "sent" }),
        delivery({ id: "d-2", status: "uncertain", source_kind: "test_send", target_key: "group:oc_9" }),
      ],
      limit: 50,
      offset: 0,
    });
    renderSection();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Uncertain")).toBeInTheDocument();
    expect(screen.getByText("Test message")).toBeInTheDocument();
    expect(screen.getByText("group:oc_9")).toBeInTheDocument();
  });

  it("shows the empty state", () => {
    renderSection();
    expect(screen.getByText(/No delivery records yet/i)).toBeInTheDocument();
  });

  it("stays silent on 403/404 — the config section owns those states", () => {
    deliveriesRef.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError("forbidden", 403, "Forbidden"),
    };
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the sent semantics note and no retry for a sent delivery", async () => {
    const user = userEvent.setup();
    deliveriesRef.current = ok({ deliveries: [delivery({ id: "d-1", status: "sent" })] });
    detailRef.current = ok({
      delivery: delivery({ id: "d-1", status: "sent" }),
      content_snapshot: {
        text: "full report body",
        summary: "run completed",
        run_status: "completed",
        has_output: true,
        link: "https://app.example/ws/issues/OL-1",
      },
      target_snapshot: { target_type: "member", user_id: "user-1" },
      source_ref: { run_id: "run-1", execution_mode: "run_only", issue_identifier: "OL-1" },
      receipts: [
        {
          id: "r-1",
          delivery_id: "d-1",
          workspace_id: "ws-1",
          installation_id: "inst-1",
          shard_index: 0,
          shard_total: 1,
          send_uuid: "5c070000-aaaa",
          external_message_id: "om_9f2",
          created_at: "2026-09-08T02:30:01Z",
          updated_at: "2026-09-08T02:30:02Z",
        },
      ],
    });
    renderSection();
    await user.click(screen.getByText("member:user-1"));

    expect(await screen.findByText("full report body")).toBeInTheDocument();
    expect(screen.getAllByText(/doesn't mean the recipient has read it/i).length).toBeGreaterThan(0);
    expect(screen.getByText("om_9f2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view task/i })).toHaveAttribute(
      "href",
      "/ws/issues/OL-1",
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
    expect(screen.getByText(/Only failed or uncertain deliveries can be retried/i)).toBeInTheDocument();
  });

  it("requires an explicit verify before retrying an uncertain delivery", async () => {
    mockRetry.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    const user = userEvent.setup();
    deliveriesRef.current = ok({ deliveries: [delivery({ id: "d-2", status: "uncertain" })] });
    detailRef.current = ok({
      delivery: delivery({ id: "d-2", status: "uncertain" }),
      content_snapshot: null,
      target_snapshot: null,
      source_ref: null,
      receipts: [],
    });
    renderSection();
    await user.click(screen.getByText("member:user-1"));

    const retryButton = await screen.findByRole("button", { name: /retry/i });
    expect(retryButton).toBeEnabled();
    await user.click(retryButton);
    // No retry until the operator confirms they checked the target first.
    expect(mockRetry).not.toHaveBeenCalled();
    expect(await screen.findByText(/Verify before retrying/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /checked — retry/i }));
    await waitFor(() => expect(mockRetry).toHaveBeenCalledTimes(1));
    expect(mockRetry.mock.calls[0]?.[0]).toEqual({ autopilotId: "ap-1", deliveryId: "d-2" });
  });

  it("hides the retry affordance from read-only users", async () => {
    const user = userEvent.setup();
    deliveriesRef.current = ok({ deliveries: [delivery({ id: "d-3", status: "failed" })] });
    detailRef.current = ok({
      delivery: delivery({ id: "d-3", status: "failed", error_code: "send_rejected" }),
      content_snapshot: null,
      target_snapshot: null,
      source_ref: null,
      receipts: [],
    });
    renderSection(false);
    await user.click(screen.getByText("member:user-1"));

    expect(await screen.findByText("Feishu rejected the message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
  });
});
