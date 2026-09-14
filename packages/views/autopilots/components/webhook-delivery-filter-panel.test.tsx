// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiError } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import type {
  AutopilotTrigger,
  WebhookDelivery,
  WebhookEventFilter,
} from "@multica/core/types";

type QueryResult = {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
};

const idle: QueryResult = { isLoading: false, isError: false };
const ok = (data: unknown): QueryResult => ({ data, isLoading: false, isError: false });

const previewRef = vi.hoisted(() => ({
  current: { isLoading: false, isError: false } as QueryResult,
}));
const previewOptionsSpy = vi.hoisted(() => vi.fn());
const mockUpdateTrigger = vi.hoisted(() => vi.fn());
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.enabled === false) return idle;
    if (JSON.stringify(opts.queryKey).includes("filter-preview")) {
      return previewRef.current;
    }
    return idle;
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/autopilots", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@multica/core/autopilots")>();
  return {
    ...original,
    autopilotDeliveryFilterPreviewOptions: (
      wsId: string,
      autopilotId: string,
      deliveryId: string,
      filters: WebhookEventFilter[],
      options?: { enabled?: boolean },
    ) => {
      previewOptionsSpy(wsId, autopilotId, deliveryId, filters, options);
      return {
        queryKey: ["autopilots", wsId, "deliveries", autopilotId, deliveryId, "filter-preview"],
        enabled: options?.enabled ?? true,
      };
    },
    useUpdateAutopilotTrigger: () => ({
      mutateAsync: mockUpdateTrigger,
      isPending: false,
    }),
  };
});

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("sonner", () => ({ toast: toastSpy }));

import { DeliveryFilterPanel } from "./webhook-delivery-filter-panel";

// --- Fixtures ---------------------------------------------------------------

function makeTrigger(eventFilters?: WebhookEventFilter[]): AutopilotTrigger {
  return {
    id: "t-1",
    autopilot_id: "ap-1",
    kind: "webhook",
    enabled: true,
    cron_expression: null,
    timezone: null,
    next_run_at: null,
    webhook_token: "tok",
    webhook_path: "/api/webhooks/autopilots/tok",
    label: null,
    event_filters: eventFilters,
    last_fired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeDetail(
  filterContext?: WebhookDelivery["filter_context"],
): WebhookDelivery {
  return {
    id: "d-1",
    workspace_id: "ws-1",
    autopilot_id: "ap-1",
    trigger_id: "t-1",
    provider: "github",
    event: "github.workflow_run.completed",
    dedupe_key: null,
    dedupe_source: null,
    signature_status: "valid",
    status: "ignored",
    attempt_count: 1,
    dispatch_attempts: 1,
    available_at: "",
    content_type: "application/json",
    response_status: 200,
    autopilot_run_id: null,
    replayed_from_delivery_id: null,
    error: null,
    reason_code: null,
    replay_idempotency_key: null,
    received_at: "2026-01-01T00:00:00Z",
    last_attempt_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    raw_body: "{}",
    filter_context: filterContext,
  };
}

const SUGGESTION: WebhookEventFilter = {
  event: "workflow_run",
  actions: ["completed", "success"],
};

function renderPanel(
  overrides: Partial<Parameters<typeof DeliveryFilterPanel>[0]> = {},
) {
  const onDirtyChange = overrides.onDirtyChange ?? vi.fn();
  const utils = renderWithI18n(
    <DeliveryFilterPanel
      autopilotId="ap-1"
      deliveryId="d-1"
      detail={makeDetail({ suggestion: SUGGESTION, matches: null })}
      detailLoading={false}
      detailError={null}
      trigger={makeTrigger([{ event: "issues" }])}
      canWrite={true}
      onDirtyChange={onDirtyChange}
      {...overrides}
    />,
  );
  return { ...utils, onDirtyChange };
}

beforeEach(() => {
  cleanup();
  previewRef.current = ok(makeDetail({ suggestion: SUGGESTION, matches: false }));
  previewOptionsSpy.mockClear();
  mockUpdateTrigger.mockReset();
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

// --- Display states ---------------------------------------------------------

describe("DeliveryFilterPanel", () => {
  it("shows the server-derived suggestion and the match verdict", () => {
    renderPanel();
    expect(screen.getByText("Suggested condition")).toBeInTheDocument();
    expect(screen.getByText("workflow_run")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(
      screen.getByText("This delivery would be filtered out"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    ).toBeInTheDocument();
  });

  it("shows the accepting verdict when the preview matches", () => {
    previewRef.current = ok(
      makeDetail({ suggestion: SUGGESTION, matches: true }),
    );
    renderPanel();
    expect(
      screen.getByText("This delivery would be accepted"),
    ).toBeInTheDocument();
  });

  it("explains a null verdict instead of guessing", () => {
    previewRef.current = ok(
      makeDetail({ suggestion: SUGGESTION, matches: null }),
    );
    renderPanel();
    expect(
      screen.getByText("The match result can't be determined"),
    ).toBeInTheDocument();
  });

  it("shows the evaluating state while the preview is in flight", () => {
    previewRef.current = { isLoading: true, isError: false };
    renderPanel();
    expect(screen.getByText("Evaluating...")).toBeInTheDocument();
  });

  it("surfaces a preview failure without touching the suggestion", () => {
    previewRef.current = { isLoading: false, isError: true };
    renderPanel();
    expect(screen.getByText("Couldn't evaluate the match")).toBeInTheDocument();
    expect(screen.getByText("workflow_run")).toBeInTheDocument();
  });

  it("treats a missing filter_context as an unsupported server, never a guess", () => {
    renderPanel({ detail: makeDetail(undefined) });
    expect(
      screen.getByText(/doesn't provide filter suggestions/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create filter from this delivery/ }),
    ).not.toBeInTheDocument();
  });

  it("degrades a malformed (null) filter_context the same way", () => {
    renderPanel({ detail: makeDetail(null) });
    expect(
      screen.getByText(/doesn't provide filter suggestions/),
    ).toBeInTheDocument();
  });

  it("explains a missing raw body, shows format help, and skips the preview fetch", () => {
    renderPanel({
      detail: makeDetail({
        suggestion: null,
        unavailable_reason: "raw_body_missing",
        matches: null,
      }),
    });
    expect(
      screen.getByText(/raw payload wasn't stored/),
    ).toBeInTheDocument();
    expect(screen.getByText(/A condition is an event name/)).toBeInTheDocument();
    expect(
      screen.getByText("The match result can't be determined"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create filter from this delivery/ }),
    ).not.toBeInTheDocument();
    // Contract: matches is guaranteed null here — no fetch is spent on it.
    expect(previewOptionsSpy).toHaveBeenCalledWith(
      "ws-1",
      "ap-1",
      "d-1",
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("still previews the real verdict for event_empty deliveries", () => {
    renderPanel({
      detail: makeDetail({
        suggestion: null,
        unavailable_reason: "event_empty",
        matches: null,
      }),
    });
    expect(
      screen.getByText(/no usable event name/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create filter from this delivery/ }),
    ).not.toBeInTheDocument();
    expect(previewOptionsSpy).toHaveBeenCalledWith(
      "ws-1",
      "ap-1",
      "d-1",
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("explains an unknown future unavailable_reason via the default arm", () => {
    renderPanel({
      detail: makeDetail({
        suggestion: null,
        unavailable_reason: "payload_expired",
        matches: null,
      }),
    });
    expect(
      screen.getByText("No condition can be derived from this delivery."),
    ).toBeInTheDocument();
  });

  it("reports an unavailable delivery (404) distinctly", () => {
    renderPanel({
      detail: undefined,
      detailError: new ApiError("delivery not found", 404, "Not Found"),
    });
    expect(
      screen.getByText(/This delivery is unavailable/),
    ).toBeInTheDocument();
  });

  it("reports a generic load failure", () => {
    renderPanel({
      detail: undefined,
      detailError: new ApiError("boom", 500, "Internal Server Error"),
    });
    expect(
      screen.getByText(/Couldn't load the filter suggestion/),
    ).toBeInTheDocument();
  });

  it("hides the editing affordance for read-only users", () => {
    renderPanel({ canWrite: false });
    expect(
      screen.queryByRole("button", { name: /Create filter from this delivery/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/)).toBeInTheDocument();
  });

  // --- Bring-in flow ----------------------------------------------------------
  // Dedupe boundary cases of the bring-in merge live at the helper level:
  // packages/core/autopilots/webhook.test.ts (mergeWebhookFilterSuggestion).
  // The tests here only cover the panel wiring.

  it("brings the suggestion into the draft without saving", async () => {
    const { onDirtyChange } = renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    );

    // The editor now holds saved row + suggestion row (nothing saved yet).
    expect(screen.getAllByRole("button", { name: "Remove filter" })).toHaveLength(2);
    expect(mockUpdateTrigger).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenCalledWith(true),
    );
    // The live preview re-targets the merged draft.
    expect(previewOptionsSpy).toHaveBeenLastCalledWith(
      "ws-1",
      "ap-1",
      "d-1",
      [{ event: "issues" }, SUGGESTION],
      expect.objectContaining({ enabled: true }),
    );
  });

  it("keeps manual multi-row editing inside the draft", () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    );
    fireEvent.change(screen.getByPlaceholderText("e.g. workflow_run"), {
      target: { value: "issues" },
    });
    fireEvent.change(screen.getByPlaceholderText("completed, failed"), {
      target: { value: "opened" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getAllByRole("button", { name: "Remove filter" })).toHaveLength(3);
    expect(mockUpdateTrigger).not.toHaveBeenCalled();
  });

  it("saves the merged draft through the trigger mutation", async () => {
    mockUpdateTrigger.mockResolvedValue(makeTrigger());
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save filters" }));

    await waitFor(() =>
      expect(mockUpdateTrigger).toHaveBeenCalledWith({
        autopilotId: "ap-1",
        triggerId: "t-1",
        event_filters: [{ event: "issues" }, SUGGESTION],
      }),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalled());
    // Back to read mode after a successful save.
    expect(screen.queryByRole("button", { name: "Save filters" })).not.toBeInTheDocument();
  });

  it("sends an explicit [] when every row was removed", async () => {
    mockUpdateTrigger.mockResolvedValue(makeTrigger());
    renderPanel({ trigger: makeTrigger([SUGGESTION]) });
    fireEvent.click(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save filters" }));

    await waitFor(() =>
      expect(mockUpdateTrigger).toHaveBeenCalledWith({
        autopilotId: "ap-1",
        triggerId: "t-1",
        event_filters: [],
      }),
    );
  });

  it("keeps the draft in edit mode when the save fails", async () => {
    mockUpdateTrigger.mockRejectedValue(new Error("validation failed"));
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save filters" }));

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    // Draft rows are still there — the failed save lost nothing.
    expect(screen.getAllByRole("button", { name: "Remove filter" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save filters" })).toBeInTheDocument();
  });

  it("discards the draft on explicit cancel", async () => {
    const { onDirtyChange } = renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Create filter from this delivery/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Save filters" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(false),
    );
  });
});
