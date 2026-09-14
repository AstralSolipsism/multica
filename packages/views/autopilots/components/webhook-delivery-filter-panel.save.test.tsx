// @vitest-environment jsdom

// OL-78 review regressions: the save flow through the REAL TanStack Query
// cache and mutation hook — only the API boundary is mocked. Covers the two
// P2 findings from review: edits must be frozen while a save is in flight,
// and a successful PATCH must sync the trigger cache so a failed follow-up
// refetch never re-presents the pre-save configuration as current.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { autopilotDetailOptions, autopilotKeys } from "@multica/core/autopilots/queries";
import type { AutopilotTrigger, WebhookDelivery, WebhookEventFilter } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { DeliveryFilterPanel } from "./webhook-delivery-filter-panel";

const mocks = vi.hoisted(() => ({
  getAutopilot: vi.fn(),
  getAutopilotDelivery: vi.fn(),
  updateAutopilotTrigger: vi.fn(),
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
  error: null, reason_code: null, replay_idempotency_key: null, received_at: "",
  last_attempt_at: "", created_at: "", raw_body: "{}",
  filter_context: { suggestion, matches: null },
} satisfies WebhookDelivery;

let client: QueryClient;
let persisted: WebhookEventFilter[];
const dirty = vi.fn();

function Harness() {
  const { data } = useQuery(autopilotDetailOptions("ws-1", "ap-1"));
  if (!data) return null;
  return (
    <DeliveryFilterPanel
      autopilotId="ap-1"
      deliveryId="d-1"
      detail={detail}
      detailLoading={false}
      detailError={null}
      trigger={data.triggers[0]}
      canWrite
      onDirtyChange={dirty}
    />
  );
}

function bringIn() {
  fireEvent.click(screen.getByRole("button", { name: "Create filter from this delivery" }));
}

async function renderPanel() {
  renderWithI18n(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  await screen.findByText("This delivery would be filtered out");
}

beforeEach(() => {
  vi.clearAllMocks();
  persisted = originalFilters;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.getAutopilot.mockImplementation(async () => ({
    triggers: [{ ...trigger, event_filters: persisted }],
  }));
  // Fixed server response fixtures; the production matcher is not mocked
  // into the UI — a draft differing from the saved filters matches.
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
  mocks.updateAutopilotTrigger.mockImplementation(async (_ap, _id, data) => {
    persisted = data.event_filters;
    return { ...trigger, event_filters: persisted };
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("freezes the whole editor while a save is in flight", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.updateAutopilotTrigger.mockImplementation(async (_ap, _id, data) => {
    await pending;
    persisted = data.event_filters;
    return { ...trigger, event_filters: persisted };
  });

  await renderPanel();
  bringIn();
  fireEvent.click(screen.getByRole("button", { name: "Save filters" }));
  await screen.findByRole("button", { name: "Saving..." });

  // Inputs, add and remove are all disabled mid-flight — an edit accepted
  // now would not be part of the in-flight request, and the success path
  // exits edit mode, so accepting one would silently drop it.
  expect(screen.getByPlaceholderText("e.g. workflow_run")).toBeDisabled();
  expect(screen.getByPlaceholderText("completed, failed")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  for (const btn of screen.getAllByRole("button", { name: "Remove filter" })) {
    expect(btn).toBeDisabled();
  }
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

  await act(async () => {
    finish();
    await pending;
  });
  await waitFor(() => expect(mocks.success).toHaveBeenCalled());
  // Exactly the submitted draft was persisted — no more, no less.
  expect(mocks.updateAutopilotTrigger).toHaveBeenCalledWith("ap-1", "t-1", {
    event_filters: [...originalFilters, suggestion],
  });
  // A clean save exits edit mode and clears the dirty guard.
  await waitFor(() => expect(dirty.mock.lastCall?.[0]).toBe(false));
  expect(screen.queryByRole("button", { name: "Save filters" })).toBeNull();
});

it("shows the just-saved filters' verdict even when the detail refetch fails", async () => {
  await renderPanel();
  bringIn();
  await screen.findByText("This delivery would be accepted");

  // PATCH succeeds; the invalidation's follow-up GET fails.
  mocks.getAutopilot.mockRejectedValue(new Error("temporary detail reload failure"));
  fireEvent.click(screen.getByRole("button", { name: "Save filters" }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalled());
  await waitFor(() =>
    expect(client.getQueryState(autopilotKeys.detail("ws-1", "ap-1"))?.status).toBe("error"),
  );

  expect(persisted).toEqual([...originalFilters, suggestion]);
  // The PATCH response was synced into the cache, so the read-mode preview
  // evaluates the NEW saved filters — the stale "filtered out" verdict for
  // the pre-save configuration must never reappear.
  expect(screen.queryByText("This delivery would be filtered out")).toBeNull();
  await screen.findByText("This delivery would be accepted");
});
