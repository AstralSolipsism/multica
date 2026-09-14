// @vitest-environment jsdom

// OL-78 review regression: the delivery detail dialog (and the filter draft
// inside it) lives outside the list-row lifecycle. The list holds only the
// newest N deliveries, so a realtime refresh can evict the open row — the
// dialog and its unsaved draft must survive, and only an explicit close runs
// the discard guard.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { autopilotKeys } from "@multica/core/autopilots/queries";
import { ApiError } from "@multica/core/api";
import type { AutopilotTrigger, WebhookDelivery, WebhookEventFilter } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { WebhookDeliveriesSection } from "./webhook-deliveries-section";

const mocks = vi.hoisted(() => ({
  getAutopilotDelivery: vi.fn(),
  updateAutopilotTrigger: vi.fn(),
  listAutopilotDeliveries: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: mocks,
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const originalFilters: WebhookEventFilter[] = [{ event: "push", actions: ["created"] }];
const suggestion: WebhookEventFilter = { event: "workflow_run", actions: ["completed", "success"] };
const trigger = {
  id: "t-1", autopilot_id: "ap-1", kind: "webhook", enabled: true,
  cron_expression: null, timezone: null, next_run_at: null, webhook_token: "tok",
  webhook_path: "/api/webhooks/autopilots/tok", label: null, event_filters: originalFilters,
  last_fired_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
} satisfies AutopilotTrigger;
const detail = {
  id: "d-1", workspace_id: "ws-1", autopilot_id: "ap-1", trigger_id: "t-1",
  provider: "github", event: "github.workflow_run.completed", dedupe_key: null,
  dedupe_source: null, signature_status: "valid", status: "ignored", attempt_count: 1,
  dispatch_attempts: 1, available_at: "", content_type: "application/json",
  response_status: 200, autopilot_run_id: null, replayed_from_delivery_id: null,
  error: null, reason_code: null, replay_idempotency_key: null,
  received_at: "2026-01-01T00:00:00Z", last_attempt_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z", raw_body: "{}",
  filter_context: { suggestion, matches: null },
} satisfies WebhookDelivery;

let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.listAutopilotDeliveries.mockResolvedValue({ deliveries: [detail], total: 1 });
  mocks.getAutopilotDelivery.mockImplementation(async (_ap, _id, params) => ({
    ...detail,
    filter_context: {
      suggestion,
      matches:
        params?.eventFilters === undefined
          ? null
          : JSON.stringify(params.eventFilters) !== JSON.stringify(originalFilters),
    },
  }));
  mocks.updateAutopilotTrigger.mockResolvedValue(trigger);
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("keeps a dirty delivery dialog open when the refreshed list no longer contains that delivery", async () => {
  renderWithI18n(
    <QueryClientProvider client={client}>
      <WebhookDeliveriesSection
        autopilotId="ap-1"
        hasWebhookTrigger
        triggers={[trigger]}
        canWrite
      />
    </QueryClientProvider>,
  );

  // Open the dialog from the row and start a draft.
  fireEvent.click(await screen.findByText("github.workflow_run.completed"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Create filter from this delivery" }),
  );
  expect(screen.getAllByRole("button", { name: "Remove filter" })).toHaveLength(2);

  // The explicit-close guard works: Esc detours to the discard confirmation.
  fireEvent.keyDown(document, { key: "Escape" });
  await screen.findByText("Discard unsaved filter changes?");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

  // A refreshed newest-N response pushes the selected delivery off the page.
  act(() =>
    client.setQueryData(autopilotKeys.deliveries("ws-1", "ap-1"), {
      deliveries: [{ ...detail, id: "d-new", event: "github.push" }],
      total: 1,
    }),
  );
  await screen.findByText("github.push");

  // The dialog, the draft and the open edit session are untouched; nothing
  // was saved or discarded behind the user's back.
  expect(mocks.updateAutopilotTrigger).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button", { name: "Remove filter" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Save filters" })).toBeInTheDocument();
  // The evicted row's detail renders from the cached detail query.
  expect(screen.getAllByText("github.workflow_run.completed").length).toBeGreaterThan(0);
});

// The row can leave the list while its detail request is still in flight.
// If that request then fails, the dialog must surface the existing error
// copy — never skeletons forever.
it.each([404, 500])(
  "reports HTTP %i when the selected row leaves the list before the detail load fails",
  async (status) => {
    let rejectDetail!: (reason: unknown) => void;
    const pending = new Promise<WebhookDelivery>((_resolve, reject) => {
      rejectDetail = reject;
    });
    mocks.getAutopilotDelivery.mockImplementation(() => pending);

    renderWithI18n(
      <QueryClientProvider client={client}>
        <WebhookDeliveriesSection
          autopilotId="ap-1"
          hasWebhookTrigger
          triggers={[trigger]}
          canWrite
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText("github.workflow_run.completed"));
    await waitFor(() =>
      expect(mocks.getAutopilotDelivery).toHaveBeenCalledWith("ap-1", "d-1"),
    );

    // Evict the row, then fail the in-flight detail request.
    act(() =>
      client.setQueryData(autopilotKeys.deliveries("ws-1", "ap-1"), {
        deliveries: [{ ...detail, id: "d-new", event: "github.push" }],
        total: 1,
      }),
    );
    await screen.findByText("github.push");
    await act(async () => {
      rejectDetail(
        new ApiError(
          "detail failed",
          status,
          status === 404 ? "Not Found" : "Internal Server Error",
        ),
      );
      await pending.catch(() => undefined);
    });
    await waitFor(() =>
      expect(
        client.getQueryState(autopilotKeys.delivery("ws-1", "ap-1", "d-1"))?.status,
      ).toBe("error"),
    );

    expect(mocks.updateAutopilotTrigger).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await screen.findByText(
      status === 404
        ? /This delivery is unavailable/
        : /Couldn't load the filter suggestion/,
    );
  },
);
