// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MessageSourceDelivery, MessageSourceRoute } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

import { SourceRouteRow } from "./source-route-row";

const mockSetEnabled = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockTestSend = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/message-delivery", () => ({
  useSetMessageSourceRouteEnabled: () => ({ mutate: mockSetEnabled, isPending: false }),
  useDeleteMessageSourceRoute: () => ({ mutate: mockDelete, isPending: false }),
  useTestMessageSourceRoute: () => ({ mutate: mockTestSend, isPending: false }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_t: string, id: string) => `Agent ${id}` }),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning },
}));

const INSTALLATION = { id: "inst-1", agent_id: "agent-1", status: "active" };

const PERSONAL_ROUTE: MessageSourceRoute = {
  id: "route-1",
  workspace_id: "ws-1",
  autopilot_id: null,
  source_kind: "inbox",
  installation_id: "inst-1",
  channel_type: "feishu",
  target_type: "member",
  target_user_id: "user-1",
  target_chat_id: null,
  target_message_id: null,
  target_thread_id: null,
  target_key: "member:user-1",
  project_id: null,
  event_types: [],
  enabled: true,
  revision: 2,
  created_by: "user-1",
  updated_by: "user-1",
  effective_from: "2026-09-08T02:30:00Z",
  last_disabled_at: null,
  created_at: "2026-09-08T02:30:00Z",
  updated_at: "2026-09-08T02:30:00Z",
};

const TEAM_ROUTE: MessageSourceRoute = {
  ...PERSONAL_ROUTE,
  id: "route-2",
  source_kind: "activity",
  target_type: "group",
  target_user_id: null,
  target_chat_id: "oc_1",
  target_key: "group:oc_1",
  project_id: "p1",
  event_types: ["status_changed"],
  revision: 3,
};

function renderRow(overrides: {
  route?: MessageSourceRoute;
  installations?: { id: string; agent_id: string; status: string }[];
  projects?: { id: string; title: string }[];
  canManage?: boolean;
} = {}) {
  return renderWithI18n(
    <SourceRouteRow
      route={overrides.route ?? PERSONAL_ROUTE}
      installations={overrides.installations ?? [INSTALLATION]}
      projects={overrides.projects}
      canManage={overrides.canManage ?? true}
      onEdit={() => {}}
      onShowRecords={() => {}}
    />,
  );
}

describe("SourceRouteRow", () => {
  beforeEach(() => {
    mockSetEnabled.mockReset();
    mockDelete.mockReset();
    mockTestSend.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    toastWarning.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles enabled with the row's displayed revision as the guard", async () => {
    mockSetEnabled.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("switch", { name: "Personal notifications" }));

    expect(mockSetEnabled).toHaveBeenCalledTimes(1);
    expect(mockSetEnabled).toHaveBeenCalledWith(
      { routeId: "route-1", enabled: false, expectedRevision: 2 },
      expect.anything(),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Push target disabled");
  });

  it("disables test-send while the route is disabled and says why", () => {
    renderRow({ route: { ...PERSONAL_ROUTE, enabled: false } });
    const button = screen.getByRole("button", { name: /send test/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Enable this target before sending a test message.",
    );
  });

  it.each([
    ["sent", "success", "Test message Sent"],
    ["failed", "error", "Test message Failed"],
    ["uncertain", "warning", "Test message Uncertain"],
  ] as const)("test-send toasts the real returned status: %s → %s", async (status, channel, message) => {
    mockTestSend.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: (d: MessageSourceDelivery) => void }) =>
        opts.onSuccess?.({ status } as MessageSourceDelivery),
    );
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: /send test/i }));

    expect(mockTestSend).toHaveBeenCalledWith({ routeId: "route-1" }, expect.anything());
    expect({ success: toastSuccess, error: toastError, warning: toastWarning }[channel])
      .toHaveBeenCalledWith(message);
  });

  it("deletes only after the AlertDialog confirm", async () => {
    mockDelete.mockImplementation(
      (_vars: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.(),
    );
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete this push target?")).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    expect(mockDelete).toHaveBeenCalledWith({ routeId: "route-1" }, expect.anything());
    expect(toastSuccess).toHaveBeenCalledWith("Push target deleted");
  });

  it("renders a personal row: self target label, no source-kind badge", () => {
    renderRow();
    expect(screen.getByText("Your Feishu DM")).toBeInTheDocument();
    expect(screen.getByText("Agent agent-1")).toBeInTheDocument();
    expect(screen.getByText("All events")).toBeInTheDocument();
    // The inbox badge is withheld on personal rows (the switch's aria-label
    // carries the scope name instead, which getByText never matches).
    expect(screen.queryByText("Personal notifications")).not.toBeInTheDocument();
    expect(screen.queryByText("Whole workspace")).not.toBeInTheDocument();
  });

  it("renders a team row with source-kind and project badges", () => {
    renderRow({ route: TEAM_ROUTE, projects: [{ id: "p1", title: "Alpha" }] });
    expect(screen.getByText("oc_1")).toBeInTheDocument();
    expect(screen.getByText("Task activity")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("1 events")).toBeInTheDocument();
  });

  it("falls back to the Whole workspace badge for a workspace-scoped team route", () => {
    renderRow({
      route: { ...TEAM_ROUTE, project_id: null },
      projects: [{ id: "p1", title: "Alpha" }],
    });
    expect(screen.getByText("Whole workspace")).toBeInTheDocument();
  });

  it("flags a revoked or missing bot with the bot_revoked badge", () => {
    renderRow({ installations: [{ ...INSTALLATION, status: "revoked" }] });
    expect(screen.getByText("Bot revoked")).toBeInTheDocument();
    expect(screen.getByText("Agent agent-1")).toBeInTheDocument();

    cleanup();
    renderRow({ installations: [] });
    expect(screen.getByText("Bot revoked")).toBeInTheDocument();
    expect(screen.getByText("Unknown bot")).toBeInTheDocument();
  });

  it("hides manage actions for read-only viewers", () => {
    renderRow({ canManage: false });
    // Base UI marks a disabled switch with data-disabled (no native attribute).
    expect(screen.getByRole("switch", { name: "Personal notifications" })).toHaveAttribute(
      "data-disabled",
    );
    expect(screen.queryByRole("button", { name: /send test/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^records$/i })).toBeInTheDocument();
  });
});
