// @vitest-environment jsdom

// Isolated OL-28 rereview: use the production queries, mutations, API parser,
// and QueryClient with local HTTP responses. No request leaves this process.

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiClient } from "@multica/core/api/client";
import { setApiInstance } from "@multica/core/api";
import { createQueryClient } from "@multica/core/query-client";
import { messageSourceKeys } from "@multica/core/message-delivery";
import type { MessageEventCatalog } from "@multica/core/types";
import { TeamSubscriptionsSection } from "./team-subscriptions-section";
import { PersonalFeishuPushSection } from "./personal-push-section";
import { MessageDeliverySection } from "./message-delivery-section";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws1" }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: "owner", isLoading: false }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Review Bot" }),
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

const CATALOG: MessageEventCatalog = {
  personal: {
    source_kind: "inbox",
    target_type: "member",
    event_types: [{ type: "issue_assigned", group: "assignments", label: "Issue assigned to you" }],
  },
  team: [{
    source_kind: "activity",
    events: [{ event: "status_changed", label: "Issue status changed" }],
  }],
};

const CATALOG_ERROR = "Couldn't load the event catalog, so the event scope can't be confirmed. Reload it before saving.";
const APPROVALS_ERROR = "Couldn't load the approved targets.";
const APPROVAL = {
  id: "a1", workspace_id: "ws1", autopilot_id: null,
  source_kind: "activity", project_id: null, installation_id: "i1",
  target_key: "group:oc_team", target_type: "group", approved_by: "u1",
  approved_at: "2026-09-10T00:00:00Z", revoked_at: null,
};

const activeClients: ReturnType<typeof createQueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of activeClients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(
  mode: "personal" | "team" | "automation" = "team",
  initial: { catalogMalformed?: boolean; routesMalformed?: boolean } = {},
) {
  const client = createQueryClient();
  activeClients.push(client);
  const state = {
    catalogFailed: false,
    catalogMalformed: false,
    approvalsFailed: false,
    routesFailed: false,
    routesMalformed: false,
    approvals: [] as typeof APPROVAL[],
    ...initial,
  };
  const createRequests = vi.fn();
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/message-event-catalog") {
      return state.catalogFailed
        ? response({ error: "catalog unavailable" }, 500)
        : response(state.catalogMalformed ? {} : CATALOG);
    }
    if (path === "/api/autopilots/ap1/message-routes") return response({ routes: [] });
    if (path === "/api/autopilots/ap1/message-approved-targets") {
      return response({ approved_targets: [{ ...APPROVAL, autopilot_id: "ap1" }] });
    }
    if (path === "/api/autopilots/ap1/message-approved-targets/a1" && method === "DELETE") return response({});
    if (path === "/api/workspaces/ws1/members") return response([]);
    if (path === "/api/message-approved-targets") {
      if (method === "POST") return response({ approved_target: APPROVAL }, 201);
      return state.approvalsFailed
        ? response({ error: "approvals unavailable" }, 500)
        : response({ approved_targets: state.approvals });
    }
    if (path === "/api/message-routes") {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body));
        createRequests(body);
        return response({ route: { id: "r1", workspace_id: "ws1", ...body, revision: 1 } }, 201);
      }
      return state.routesFailed
        ? response({ error: "routes unavailable" }, 500)
        : response(state.routesMalformed ? {} : { routes: [] });
    }
    if (path === "/api/workspaces/ws1/lark/installations") {
      return response({
        installations: [{
          id: "i1", workspace_id: "ws1", agent_id: "agent1", app_id: "cli_test",
          bot_open_id: "ou_bot", installer_user_id: "u1", status: "active", region: "feishu",
          installed_at: "2026-09-10T00:00:00Z", created_at: "2026-09-10T00:00:00Z",
          updated_at: "2026-09-10T00:00:00Z",
        }],
        configured: true,
      });
    }
    if (path === "/api/projects") return response({ projects: [] });
    throw new Error(`Unexpected review request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  setApiInstance(new ApiClient("https://review.example.test"));
  renderWithI18n(
    <QueryClientProvider client={client}>
      <NavigationProvider value={{
        push: () => {}, replace: () => {}, back: () => {},
        pathname: "/ws/settings", searchParams: new URLSearchParams(), hash: "",
        getShareableUrl: (path: string) => path,
      }}>
        {mode === "team" ? <TeamSubscriptionsSection /> : mode === "automation"
          ? <MessageDeliverySection autopilotId="ap1" canWrite executionMode="run_only" />
          : <PersonalFeishuPushSection />}
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return { client, state, createRequests, fetch, user: userEvent.setup() };
}

it.each(["personal", "team"] as const)(
  "%s: an unreadable initial catalog cannot be saved as event_types: []",
  async (mode) => {
    const harness = setup(mode, { catalogMalformed: true });
    const add = await screen.findByRole("button", { name: mode === "team" ? "Add subscription" : "Set up push" });
    await waitFor(() => expect(add).toBeEnabled());
    await harness.user.click(add);
    if (mode === "team") await harness.user.type(screen.getByPlaceholderText("oc_..."), "oc_team");
    await screen.findByText(CATALOG_ERROR);
    const save = screen.getByRole("button", { name: /^save$|approve.*save|save.*approve/i });
    expect(save).toBeDisabled();
    await harness.user.click(save);
    expect(harness.createRequests).not.toHaveBeenCalled();
  },
);

it("an unreadable personal route list shows an error instead of claiming push is not configured", async () => {
  setup("personal", { routesMalformed: true });
  await screen.findByText("Couldn't load the push configuration.");
  expect(screen.queryByText(/Feishu push isn't set up yet/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set up push" })).not.toBeInTheDocument();
});

it("a malformed catalog refresh blocks saving even when the cache retains the previous catalog", async () => {
  const harness = setup();
  await openEditor(harness, "team");
  harness.state.catalogMalformed = true;
  await act(async () => {
    await harness.client.refetchQueries({ queryKey: messageSourceKeys.catalog("ws1") });
  });
  await screen.findByText(CATALOG_ERROR);
  expect(screen.getByRole("button", { name: /approve.*save|save.*approve/i })).toBeDisabled();
  expect(harness.createRequests).not.toHaveBeenCalled();
});

it("an unconfirmed automation approval revoke reports an error instead of success", async () => {
  const harness = setup("automation");
  await screen.findByText("group:oc_team");
  await harness.user.click(screen.getByRole("button", { name: /^revoke$/i }));
  await harness.user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^revoke$/i }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalled();
  expect(harness.fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/autopilots/ap1/message-approved-targets/a1"),
    expect.objectContaining({ method: "DELETE" }),
  );
});

async function openEditor(harness: ReturnType<typeof setup>, mode: "personal" | "team") {
  const add = await screen.findByRole("button", { name: mode === "team" ? "Add subscription" : "Set up push" });
  await waitFor(() => expect(add).toBeEnabled());
  await harness.user.click(add);
  await screen.findByRole("checkbox");
  if (mode === "team") await harness.user.type(screen.getByPlaceholderText("oc_..."), "oc_team");
}

it.each(["personal", "team"] as const)(
  "%s: blocks saving after a successful catalog read is followed by a failed refresh with retained data",
  async (mode) => {
    const harness = setup(mode);
    await openEditor(harness, mode);
    harness.state.catalogFailed = true;
    await act(async () => {
      await harness.client.refetchQueries({ queryKey: messageSourceKeys.catalog("ws1") });
    });
    await screen.findByText(CATALOG_ERROR);
    expect(harness.client.getQueryData(messageSourceKeys.catalog("ws1"))).toEqual(CATALOG);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^save$|approve.*save|save.*approve/i })).toBeDisabled();
    expect(harness.createRequests).not.toHaveBeenCalled();
  },
);

it("reloads a failed catalog refresh, restores the filter, and saves the next operation with the selected event", async () => {
  const harness = setup();
  await openEditor(harness, "team");
  harness.state.catalogFailed = true;
  await act(async () => {
    await harness.client.refetchQueries({ queryKey: messageSourceKeys.catalog("ws1") });
  });
  await screen.findByText(CATALOG_ERROR);
  harness.state.catalogFailed = false;
  await harness.user.click(screen.getByRole("button", { name: /^reload$/i }));
  const event = await screen.findByRole("checkbox", { name: /^issue status changed$/i });
  expect(screen.queryByText(CATALOG_ERROR)).not.toBeInTheDocument();
  await harness.user.click(event);
  await harness.user.click(screen.getByRole("button", { name: /approve.*save|save.*approve/i }));
  await waitFor(() => expect(harness.createRequests).toHaveBeenCalledTimes(1));
  expect(harness.createRequests).toHaveBeenCalledWith(expect.objectContaining({
    source_kind: "activity", target_chat_id: "oc_team", event_types: ["status_changed"],
  }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("keeps a failed approvals refresh distinct from empty and shows the current empty list only after Reload succeeds", async () => {
  const harness = setup();
  harness.state.approvals = [APPROVAL];
  await screen.findByText("group:oc_team");
  harness.state.approvalsFailed = true;
  await act(async () => {
    await harness.client.refetchQueries({ queryKey: messageSourceKeys.approvedTargets("ws1") });
  });
  await screen.findByText(APPROVALS_ERROR);
  expect(screen.queryByText("No approved team targets yet.")).not.toBeInTheDocument();
  expect(screen.queryByText("group:oc_team")).not.toBeInTheDocument();
  harness.state.approvalsFailed = false;
  harness.state.approvals = [];
  await harness.user.click(screen.getByRole("button", { name: /^reload$/i }));
  await screen.findByText("No approved team targets yet.");
  expect(screen.queryByText(APPROVALS_ERROR)).not.toBeInTheDocument();
});

it("preserves an unsaved team route after a background routes refresh fails and then recovers", async () => {
  const harness = setup();
  await openEditor(harness, "team");
  await harness.user.click(screen.getByRole("checkbox", { name: /^issue status changed$/i }));
  expect(screen.getByPlaceholderText("oc_...")).toHaveValue("oc_team");
  harness.state.routesFailed = true;
  await act(async () => {
    await harness.client.refetchQueries({ queryKey: messageSourceKeys.routes("ws1") });
  });
  await screen.findByText("Couldn't load team subscriptions.");
  harness.state.routesFailed = false;
  await act(async () => {
    await harness.client.refetchQueries({ queryKey: messageSourceKeys.routes("ws1") });
  });
  await screen.findByRole("dialog");
  expect.soft(screen.getByPlaceholderText("oc_...")).toHaveValue("oc_team");
  expect(screen.getByRole("checkbox", { name: /^issue status changed$/i })).toBeChecked();
});
