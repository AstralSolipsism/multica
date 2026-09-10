// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@multica/core/api";
import type {
  MessageEventCatalog,
  MessageSourceApprovedTarget,
  MessageSourceRoute,
} from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

import { SourceRouteEditorDialog } from "./source-route-editor-dialog";

// Post-409 reload control: fetchQuery returns the raw envelope (select is
// observer-only); fetchQueryBehavior simulates a failing reload on demand.
const reloadRoutesRef = vi.hoisted(() => ({ current: [] as MessageSourceRoute[] }));
const fetchQueryBehavior = vi.hoisted(() => ({ current: "ok" as "ok" | "reject" }));

const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockApprove = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    fetchQuery: async () => {
      if (fetchQueryBehavior.current === "reject") {
        throw new ApiError("boom", 500, "Internal Server Error");
      }
      return { routes: reloadRoutesRef.current };
    },
  }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageSourceRoutesOptions: (_wsId: string, sourceKind?: string) => ({
    queryKey: ["message-sources", "ws-1", "routes", sourceKind ?? "all"],
  }),
  useCreateMessageSourceRoute: () => ({ mutateAsync: mockCreate, isPending: false }),
  useUpdateMessageSourceRoute: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useApproveMessageSourceTarget: () => ({ mutateAsync: mockApprove, isPending: false }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_t: string, id: string) => `Agent ${id}` }),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: vi.fn() },
}));

const INSTALLATION = { id: "inst-1", agent_id: "agent-1", status: "active", region: "feishu" };

const CATALOG: MessageEventCatalog = {
  personal: {
    source_kind: "inbox",
    target_type: "member",
    event_types: [
      { type: "issue_assigned", group: "assignments", label: "Issue assigned to you" },
      { type: "new_comment", group: "comments", label: "New comment" },
      { type: "status_changed", group: "status_changes", label: "Status changed" },
    ],
  },
  team: [
    {
      source_kind: "activity",
      events: [
        { event: "status_changed", label: "Issue status changed" },
        { event: "assignee_changed", label: "Issue assignee changed" },
      ],
    },
    { source_kind: "comment", events: [{ event: "comment", label: "New comment" }] },
  ],
};

const PROJECTS = [{ id: "p1", title: "Alpha" }];

function approval(overrides: Partial<MessageSourceApprovedTarget> = {}): MessageSourceApprovedTarget {
  return {
    id: "t1",
    workspace_id: "ws-1",
    autopilot_id: null,
    source_kind: "activity",
    project_id: "p1",
    installation_id: "inst-1",
    target_key: "group:oc_1",
    target_type: "group",
    approved_by: "user-1",
    approved_at: "2026-09-08T02:30:00Z",
    revoked_at: null,
    ...overrides,
  };
}

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
  // Deliberately unsorted: the save payload must come out sorted.
  event_types: ["new_comment", "issue_assigned"],
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
  source_kind: "activity",
  target_type: "group",
  target_user_id: null,
  target_chat_id: "oc_1",
  target_key: "group:oc_1",
  project_id: "p1",
  event_types: ["status_changed"],
  revision: 3,
};

function renderEditor(overrides: Partial<Parameters<typeof SourceRouteEditorDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  renderWithI18n(
    <SourceRouteEditorDialog
      open
      onOpenChange={onOpenChange}
      mode={overrides.mode ?? "personal"}
      route={overrides.route ?? null}
      installations={overrides.installations ?? [INSTALLATION]}
      approvals={overrides.approvals}
      projects={overrides.projects}
      // `in`, not ??: an explicit `catalog: undefined` is the no-catalog case.
      catalog={"catalog" in overrides ? overrides.catalog : CATALOG}
    />,
  );
  return onOpenChange;
}

describe("SourceRouteEditorDialog (personal)", () => {
  beforeEach(() => {
    reloadRoutesRef.current = [];
    fetchQueryBehavior.current = "ok";
    mockCreate.mockReset().mockResolvedValue({});
    mockUpdate.mockReset().mockResolvedValue({});
    mockApprove.mockReset().mockResolvedValue({});
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a personal route pinned to the acting member — no target picker fields", async () => {
    const onOpenChange = renderEditor();
    const user = userEvent.setup();

    expect(await screen.findByText("Set up Feishu push")).toBeInTheDocument();
    expect(
      screen.getByText(/delivered to your own Feishu direct message/i),
    ).toBeInTheDocument();
    // Personal mode never exposes target type, chat id, source kind or scope.
    expect(screen.queryByRole("combobox", { name: /^target$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^source$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^scope$/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("oc_...")).not.toBeInTheDocument();

    // Select events out of order; the payload must be sorted. (Checkbox names
    // are regexes: Base UI links the wrapping <label> via aria-labelledby,
    // which overrides the aria-label and doubles the computed name.)
    await user.click(screen.getByRole("checkbox", { name: /^new comment/i }));
    await user.click(screen.getByRole("checkbox", { name: /^issue assigned to you/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const payload = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({
      source_kind: "inbox",
      installation_id: "inst-1",
      target_type: "member",
      event_types: ["issue_assigned", "new_comment"],
      enabled: true,
    });
    // The recipient is server-pinned and this surface has no conditions/content_mode.
    expect(payload).not.toHaveProperty("target_user_id");
    expect(payload).not.toHaveProperty("conditions");
    expect(payload).not.toHaveProperty("content_mode");
    expect(mockApprove).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Push target saved");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends an empty event_types array when nothing is checked, honoring the enabled toggle", async () => {
    renderEditor();
    const user = userEvent.setup();

    // The create form's enable toggle is the only switch (it has no aria-label;
    // the visible label is an unassociated sibling).
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      source_kind: "inbox",
      installation_id: "inst-1",
      target_type: "member",
      event_types: [],
      enabled: false,
    });
  });

  it("offers event checkboxes from the catalog, and none without it", async () => {
    renderEditor();
    expect(await screen.findByRole("checkbox", { name: /^issue assigned to you/i }))
      .toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^new comment/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^status changed/i })).toBeInTheDocument();

    cleanup();
    renderEditor({ catalog: undefined });
    expect(await screen.findByText("Set up Feishu push")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("updates a personal route with the sorted events and the displayed revision", async () => {
    renderEditor({ route: PERSONAL_ROUTE });
    const user = userEvent.setup();

    expect(await screen.findByText("Edit Feishu push")).toBeInTheDocument();
    // Edit mode has no enable toggle — it shows the boundary hint instead.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/restarts delivery from that moment/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      routeId: "route-1",
      source_kind: "inbox",
      installation_id: "inst-1",
      target_type: "member",
      event_types: ["issue_assigned", "new_comment"],
      expected_revision: 2,
    });
  });
});

describe("SourceRouteEditorDialog (team)", () => {
  beforeEach(() => {
    reloadRoutesRef.current = [];
    fetchQueryBehavior.current = "ok";
    mockCreate.mockReset().mockResolvedValue({});
    mockUpdate.mockReset().mockResolvedValue({});
    mockApprove.mockReset().mockResolvedValue({});
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("approves an unapproved external target in the same submit, before saving", async () => {
    renderEditor({ mode: "team", approvals: [], projects: PROJECTS });
    const user = userEvent.setup();

    expect(await screen.findByText("Add subscription")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("oc_..."), "oc_new");

    expect(
      screen.getByText(/isn't approved for this source and scope yet/i),
    ).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /approve and save/i });
    await user.click(save);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    // Approval runs first: it verifies the target live before the rule saves.
    const approveOrder = mockApprove.mock.invocationCallOrder[0];
    const createOrder = mockCreate.mock.invocationCallOrder[0];
    expect(approveOrder).toBeDefined();
    expect(createOrder).toBeDefined();
    expect(approveOrder!).toBeLessThan(createOrder!);
    expect(mockApprove).toHaveBeenCalledWith({
      source_kind: "activity",
      project_id: null,
      installation_id: "inst-1",
      target_type: "group",
      target_chat_id: "oc_new",
    });
    expect(mockCreate).toHaveBeenCalledWith({
      source_kind: "activity",
      installation_id: "inst-1",
      target_type: "group",
      event_types: [],
      project_id: null,
      target_chat_id: "oc_new",
      enabled: true,
    });
  });

  it("matches approvals by exact scope: another range or kind is NOT approved", async () => {
    renderEditor({ mode: "team", approvals: [approval()], projects: PROJECTS });
    const user = userEvent.setup();
    await screen.findByText("Add subscription");

    // Exact match: activity + project p1 + bot inst-1 + group:oc_1.
    await user.click(screen.getByRole("combobox", { name: /^scope$/i }));
    await user.click(await screen.findByRole("option", { name: "Alpha" }));
    await user.type(screen.getByPlaceholderText("oc_..."), "oc_1");
    expect(
      screen.queryByText(/isn't approved for this source and scope yet/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();

    // Workspace-wide range is a different consent scope — the project approval
    // must not cover it.
    await user.click(screen.getByRole("combobox", { name: /^scope$/i }));
    await user.click(await screen.findByRole("option", { name: "Whole workspace" }));
    expect(
      await screen.findByText(/isn't approved for this source and scope yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve and save/i })).toBeInTheDocument();

    // Back to the approved project range…
    await user.click(screen.getByRole("combobox", { name: /^scope$/i }));
    await user.click(await screen.findByRole("option", { name: "Alpha" }));
    expect(
      screen.queryByText(/isn't approved for this source and scope yet/i),
    ).not.toBeInTheDocument();

    // …but an activity approval never covers the comment kind.
    await user.click(screen.getByRole("combobox", { name: /^source$/i }));
    await user.click(await screen.findByRole("option", { name: "New comments" }));
    expect(
      await screen.findByText(/isn't approved for this source and scope yet/i),
    ).toBeInTheDocument();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("disables the source-kind select when editing a team route", async () => {
    renderEditor({ mode: "team", route: TEAM_ROUTE, approvals: [approval()], projects: PROJECTS });
    expect(await screen.findByText("Edit subscription")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^source$/i })).toBeDisabled();
    expect(screen.getByDisplayValue("oc_1")).toBeInTheDocument();
  });

  it("keeps a failed save inside the dialog with the mapped error copy", async () => {
    const onOpenChange = renderEditor({
      mode: "team",
      approvals: [approval({ project_id: null, target_key: "group:oc_9" })],
      projects: PROJECTS,
    });
    mockCreate.mockRejectedValue(
      new ApiError("bad request", 400, "Bad Request", { code: "route_target_unreachable" }),
    );
    const user = userEvent.setup();
    await screen.findByText("Add subscription");

    await user.type(screen.getByPlaceholderText("oc_..."), "oc_9");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // A failed save must surface inside the dialog — never as a saved push.
    expect(
      await screen.findByText(/the bot can't reach this chat or message/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("SourceRouteEditorDialog (409 recovery)", () => {
  beforeEach(() => {
    fetchQueryBehavior.current = "ok";
    mockCreate.mockReset().mockResolvedValue({});
    mockUpdate.mockReset();
    mockApprove.mockReset().mockResolvedValue({});
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  function renderTeamEdit() {
    return renderEditor({
      mode: "team",
      route: TEAM_ROUTE,
      approvals: [approval()],
      projects: PROJECTS,
    });
  }

  it("recovers from a conflict by adopting the other writer's FULL version", async () => {
    reloadRoutesRef.current = [TEAM_ROUTE];
    mockUpdate
      .mockImplementationOnce(() => {
        // The other writer committed v4 with a different event filter. A
        // revision-only reload would silently overwrite that choice.
        reloadRoutesRef.current = [
          { ...TEAM_ROUTE, revision: 4, event_types: ["assignee_changed"] },
        ];
        return Promise.reject(
          new ApiError("conflict", 409, "Conflict", { code: "route_revision_conflict" }),
        );
      })
      .mockResolvedValueOnce({ ...TEAM_ROUTE, revision: 5 });

    renderTeamEdit();
    const user = userEvent.setup();
    await screen.findByText("Edit subscription");

    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/updated by someone else/i)).toBeInTheDocument();
    expect(mockUpdate.mock.calls[0]?.[0].expected_revision).toBe(3);
    expect(mockUpdate.mock.calls[0]?.[0].event_types).toEqual(["status_changed"]);

    // The dialog adopted the committed version — every field, not just the
    // revision lock. The re-save carries the other writer's v4 values.
    expect(screen.getByRole("checkbox", { name: /^issue assignee changed/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^issue status changed/i })).not.toBeChecked();
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls[1]?.[0].expected_revision).toBe(4);
    expect(mockUpdate.mock.calls[1]?.[0].event_types).toEqual(["assignee_changed"]);
  });

  it("ends the adopted notice when a NEW save reports its own error", async () => {
    reloadRoutesRef.current = [TEAM_ROUTE];
    mockUpdate
      .mockImplementationOnce(() => {
        reloadRoutesRef.current = [{ ...TEAM_ROUTE, revision: 4 }];
        return Promise.reject(
          new ApiError("conflict", 409, "Conflict", { code: "route_revision_conflict" }),
        );
      })
      // The re-save on the adopted v4 fails for its own reason.
      .mockRejectedValueOnce(
        new ApiError("conflict", 409, "Conflict", { code: "route_already_exists" }),
      );

    renderTeamEdit();
    const user = userEvent.setup();
    await screen.findByText("Edit subscription");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/updated by someone else/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^save$/i }));
    // The new attempt's own error replaces the stale adopted notice.
    expect(await screen.findByText(/equivalent push target already exists/i)).toBeInTheDocument();
    expect(screen.queryByText(/updated by someone else/i)).not.toBeInTheDocument();
  });

  it("409 + failed reload: no freshness claim, save stays blocked, reload retryable", async () => {
    reloadRoutesRef.current = [TEAM_ROUTE];
    fetchQueryBehavior.current = "reject";
    mockUpdate.mockRejectedValue(
      new ApiError("conflict", 409, "Conflict", { code: "route_revision_conflict" }),
    );

    renderTeamEdit();
    const user = userEvent.setup();
    await screen.findByText("Edit subscription");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // The reload failed: NO "latest version loaded" claim, and the stale
    // draft cannot be submitted.
    expect(await screen.findByText(/couldn't load the latest version/i)).toBeInTheDocument();
    expect(screen.queryByText(/updated by someone else/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    // The explicit reload recovers: latest version adopted, save re-enabled.
    fetchQueryBehavior.current = "ok";
    reloadRoutesRef.current = [{ ...TEAM_ROUTE, revision: 4 }];
    mockUpdate.mockReset().mockResolvedValue({ ...TEAM_ROUTE, revision: 5 });
    await user.click(screen.getByRole("button", { name: /^reload$/i }));
    expect(await screen.findByText(/updated by someone else/i)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0]?.[0].expected_revision).toBe(4);
  });

  it("409 + route gone from the list: says so, never resubmits the stale draft", async () => {
    // The other actor deleted the rule; the reload finds nothing.
    reloadRoutesRef.current = [];
    mockUpdate.mockRejectedValue(
      new ApiError("conflict", 409, "Conflict", { code: "route_revision_conflict" }),
    );

    renderTeamEdit();
    const user = userEvent.setup();
    await screen.findByText("Edit subscription");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/deleted elsewhere/i)).toBeInTheDocument();
    expect(screen.queryByText(/updated by someone else/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
