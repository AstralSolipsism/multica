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

import { MessageDeliverySection } from "./message-delivery-section";

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

const routesRef = vi.hoisted(() => ({ current: ok([]) as QueryResult }));
const approvalsRef = vi.hoisted(() => ({ current: ok([]) as QueryResult }));
const DEFAULT_INSTALLATIONS = {
  installations: [
    { id: "inst-1", agent_id: "agent-1", status: "active", region: "feishu" },
  ],
  configured: true,
};
const installationsRef = vi.hoisted(() => ({
  current: undefined as unknown as QueryResult,
}));
const membersRef = vi.hoisted(() => ({
  current: ok([{ user_id: "user-1", name: "Alice", email: "alice@example.com" }]) as QueryResult,
}));
const roleRef = vi.hoisted(() => ({ current: "owner" as string }));

const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockApprove = vi.hoisted(() => vi.fn());
const mockRevoke = vi.hoisted(() => vi.fn());
const mockSetEnabled = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockTestSend = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    if (opts.enabled === false) {
      return { data: undefined, isLoading: false, isError: false, isSuccess: false };
    }
    const key = JSON.stringify(opts.queryKey);
    if (key.includes("approved-targets")) return approvalsRef.current;
    if (key.includes("routes")) return routesRef.current;
    if (key.includes("installations")) return installationsRef.current;
    if (key.includes("members")) return membersRef.current;
    return { data: undefined, isLoading: false, isError: false, isSuccess: false };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    // fetchQuery returns the raw envelope (select is observer-only).
    fetchQuery: async () => ({ routes: routesRef.current.data ?? [] }),
  }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/message-delivery", () => ({
  messageRoutesOptions: (_wsId: string, autopilotId: string) => ({
    queryKey: ["message-delivery", "ws-1", "autopilot", autopilotId, "routes"],
  }),
  messageApprovedTargetsOptions: (_wsId: string, autopilotId: string, options?: { enabled?: boolean }) => ({
    queryKey: ["message-delivery", "ws-1", "autopilot", autopilotId, "approved-targets"],
    enabled: options?.enabled ?? true,
  }),
  useCreateMessageRoute: () => ({ mutateAsync: mockCreate, isPending: false }),
  useUpdateMessageRoute: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useApproveMessageTarget: () => ({ mutateAsync: mockApprove, isPending: false }),
  useRevokeMessageTarget: () => ({
    mutate: mockRevoke,
    mutateAsync: mockRevoke,
    isPending: false,
  }),
  useSetMessageRouteEnabled: () => ({ mutate: mockSetEnabled, isPending: false }),
  useDeleteMessageRoute: () => ({ mutate: mockDelete, isPending: false }),
  useTestMessageRoute: () => ({ mutate: mockTestSend, isPending: false }),
}));

vi.mock("@multica/core/lark", () => ({
  larkInstallationsOptions: (wsId: string) => ({
    queryKey: ["lark", wsId, "installations"],
  }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
}));

vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: roleRef.current, isLoading: false }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_t: string, id: string) => `Agent ${id}` }),
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    settings: () => "/ws/settings",
    issueDetail: (id: string) => `/ws/issues/${id}`,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const ROUTE = {
  id: "route-1",
  workspace_id: "ws-1",
  autopilot_id: "ap-1",
  installation_id: "inst-1",
  channel_type: "feishu",
  target_type: "member",
  target_user_id: "user-1",
  target_chat_id: null,
  target_message_id: null,
  target_thread_id: null,
  target_key: "member:user-1",
  conditions: "success",
  content_mode: "with_output",
  enabled: true,
  revision: 3,
  created_by: "user-1",
  updated_by: "user-1",
  effective_from: "2026-09-08T02:30:00Z",
  created_at: "2026-09-08T02:30:00Z",
  updated_at: "2026-09-08T02:30:00Z",
};

function renderSection() {
  return renderWithI18n(
    <NavigationProvider value={NAV_ADAPTER}>
      <MessageDeliverySection autopilotId="ap-1" canWrite executionMode="run_only" />
    </NavigationProvider>,
  );
}

describe("MessageDeliverySection", () => {
  beforeEach(() => {
    routesRef.current = ok([]);
    approvalsRef.current = ok([]);
    installationsRef.current = ok(DEFAULT_INSTALLATIONS);
    roleRef.current = "owner";
    mockCreate.mockReset().mockResolvedValue({});
    mockUpdate.mockReset().mockResolvedValue({});
    mockApprove.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a saved route with member, bot, condition and revision", () => {
    routesRef.current = ok([ROUTE]);
    renderSection();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Agent agent-1")).toBeInTheDocument();
    expect(screen.getByText("On success")).toBeInTheDocument();
    expect(screen.getByText("Summary + report body")).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  it("shows the restricted state on a real 403 (read-only user)", () => {
    routesRef.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError("forbidden", 403, "Forbidden", { code: "autopilot_forbidden" }),
    };
    renderSection();
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add target/i })).toBeInTheDocument();
  });

  it("shows the unsupported state on 404 (server without OL-25)", () => {
    routesRef.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError("not found", 404, "Not Found"),
    };
    renderSection();
    expect(screen.getByText(/doesn't support result push yet/i)).toBeInTheDocument();
  });

  it("shows the empty state when no routes exist", () => {
    renderSection();
    expect(screen.getByText(/No push targets yet/i)).toBeInTheDocument();
  });

  it("points at integration settings when no active bot exists", () => {
    installationsRef.current = ok({ installations: [], configured: true });
    renderSection();
    expect(screen.getByText(/No Feishu bot is installed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /integration settings/i })).toHaveAttribute(
      "href",
      "/ws/settings",
    );
  });

  it("hides the approvals list from non-admins", () => {
    roleRef.current = "member";
    routesRef.current = ok([ROUTE]);
    approvalsRef.current = ok([
      {
        id: "t1",
        target_type: "group",
        target_key: "group:oc_1",
        approved_at: "2026-09-08T02:30:00Z",
      },
    ]);
    renderSection();
    expect(screen.queryByText(/Approved external targets/i)).not.toBeInTheDocument();
  });

  it("lists approved targets for admins", () => {
    routesRef.current = ok([ROUTE]);
    approvalsRef.current = ok([
      {
        id: "t1",
        workspace_id: "ws-1",
        autopilot_id: "ap-1",
        installation_id: "inst-1",
        target_type: "group",
        target_key: "group:oc_1",
        approved_by: "user-1",
        approved_at: "2026-09-08T02:30:00Z",
        revoked_at: null,
      },
    ]);
    renderSection();
    expect(screen.getByText(/Approved external targets/i)).toBeInTheDocument();
    expect(screen.getByText("group:oc_1")).toBeInTheDocument();
  });
});

describe("MessageRouteEditorDialog (via section)", () => {
  beforeEach(() => {
    routesRef.current = ok([]);
    approvalsRef.current = ok([]);
    installationsRef.current = ok(DEFAULT_INSTALLATIONS);
    roleRef.current = "owner";
    mockCreate.mockReset().mockResolvedValue({});
    mockApprove.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  async function openEditor() {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: /add target/i }));
    return user;
  }

  it("keeps save disabled until a member is chosen, then creates the route", async () => {
    const user = await openEditor();
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: /^member$/i }));
    await user.click(await screen.findByRole("option", { name: "Alice" }));

    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      autopilotId: "ap-1",
      installation_id: "inst-1",
      target_type: "member",
      target_user_id: "user-1",
      conditions: "success",
      content_mode: "summary",
      enabled: true,
    });
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("approves an unapproved group target before saving (admin)", async () => {
    const user = await openEditor();
    await user.click(screen.getByRole("combobox", { name: /^target$/i }));
    await user.click(await screen.findByRole("option", { name: /group chat/i }));

    expect(screen.getByText(/hasn't been approved yet/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("oc_..."), "oc_123");
    const save = screen.getByRole("button", { name: /approve and save/i });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    // Approval runs first: it verifies the target live before the rule saves.
    const approveOrder = mockApprove.mock.invocationCallOrder[0];
    const createOrder = mockCreate.mock.invocationCallOrder[0];
    expect(approveOrder).toBeDefined();
    expect(createOrder).toBeDefined();
    expect(approveOrder!).toBeLessThan(createOrder!);
    expect(mockApprove).toHaveBeenCalledWith({
      autopilotId: "ap-1",
      installation_id: "inst-1",
      target_type: "group",
      target_chat_id: "oc_123",
    });
    expect(mockCreate).toHaveBeenCalledWith({
      autopilotId: "ap-1",
      installation_id: "inst-1",
      target_type: "group",
      target_chat_id: "oc_123",
      conditions: "success",
      content_mode: "summary",
      enabled: true,
    });
  });

  it("keeps the dialog open with the server error when the save fails", async () => {
    mockCreate.mockRejectedValue(
      new ApiError("conflict", 409, "Conflict", { code: "route_revision_conflict" }),
    );
    const user = await openEditor();
    await user.click(screen.getByRole("combobox", { name: /^member$/i }));
    await user.click(await screen.findByRole("option", { name: "Alice" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // A failed save must surface inside the dialog — never as a saved push.
    expect(
      await screen.findByText(/changed elsewhere/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("recovers from a revision conflict by adopting the latest revision", async () => {
    routesRef.current = ok([ROUTE]); // revision 3
    mockUpdate
      .mockImplementationOnce(() => {
        // The other writer committed v4; the list refetch sees it.
        routesRef.current = ok([{ ...ROUTE, revision: 4 }]);
        return Promise.reject(
          new ApiError("conflict", 409, "Conflict", { code: "route_revision_conflict" }),
        );
      })
      .mockResolvedValueOnce({ ...ROUTE, revision: 5 });

    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await screen.findByText("Edit push target");

    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/changed elsewhere/i)).toBeInTheDocument();
    expect(mockUpdate.mock.calls[0]?.[0].expected_revision).toBe(3);

    // The dialog adopted the fresh route — the retry carries v4, not v3.
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls[1]?.[0].expected_revision).toBe(4);
  });

  it("tells collaborators that external targets need admin approval", async () => {
    roleRef.current = "member";
    const user = await openEditor();
    await user.click(screen.getByRole("combobox", { name: /^target$/i }));
    await user.click(await screen.findByRole("option", { name: /topic/i }));
    expect(
      screen.getByText(/require approval by a workspace owner\/admin/i),
    ).toBeInTheDocument();
  });
});
