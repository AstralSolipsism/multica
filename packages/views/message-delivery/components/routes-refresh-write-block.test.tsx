// @vitest-environment jsdom

// Isolated OL-28 rereview: use the production queries, mutations, API parser,
// and QueryClient with local HTTP responses. No request leaves this process.

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiClient } from "@multica/core/api/client";
import { setApiInstance } from "@multica/core/api";
import { createQueryClient } from "@multica/core/query-client";
import { messageSourceKeys } from "@multica/core/message-delivery";
import type { MessageEventCatalog } from "@multica/core/types";
import { TeamSubscriptionsSection } from "./team-subscriptions-section";
import { PersonalFeishuPushSection } from "./personal-push-section";
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
});

function setup(mode: "personal" | "team" = "team") {
  const client = createQueryClient();
  activeClients.push(client);
  const state = {
    catalogFailed: false,
    approvalsFailed: false,
    routesFailure: null as number | "network" | null,
    approvals: [] as typeof APPROVAL[],
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
        : response(CATALOG);
    }
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
      if (state.routesFailure === "network") throw new TypeError("Failed to fetch");
      return state.routesFailure != null
        ? response({ error: "routes unavailable" }, state.routesFailure)
        : response({ routes: [] });
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
        {mode === "team" ? <TeamSubscriptionsSection /> : <PersonalFeishuPushSection />}
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return { client, state, createRequests, fetch, user: userEvent.setup() };
}

async function openEditor(harness: ReturnType<typeof setup>, mode: "personal" | "team") {
  const add = await screen.findByRole("button", { name: mode === "team" ? "Add subscription" : "Set up push" });
  await waitFor(() => expect(add).toBeEnabled());
  await harness.user.click(add);
  await screen.findByRole("checkbox");
  if (mode === "team") await harness.user.type(screen.getByPlaceholderText("oc_..."), "oc_team");
}


const MODES = ["personal", "team"] as const;
const SAVE = /^save$|approve.*save|save.*approve/i;

for (const mode of MODES) {
  it.each([500, 403, 404, "network"] as const)(
    mode + ": keeps the draft but blocks a write after a retained routes refresh fails with %s",
    async (failure) => {
      const harness = setup(mode);
      await openEditor(harness, mode);
      await harness.user.click(screen.getByRole("checkbox"));
      harness.state.routesFailure = failure;
      await act(async () => {
        await harness.client.refetchQueries({ queryKey: messageSourceKeys.routesAll("ws1") });
      });
      expect(harness.client.getQueryState(messageSourceKeys.routes("ws1", mode === "personal" ? "inbox" : undefined))?.status).toBe("error");
      expect(screen.getByRole("checkbox")).toBeChecked();
      if (mode === "team") expect(screen.getByPlaceholderText("oc_...")).toHaveValue("oc_team");
      const save = screen.getByRole("button", { name: SAVE });
      expect.soft(save).toBeDisabled();
      await harness.user.click(save);
      expect(harness.createRequests).toHaveBeenCalledTimes(0);
    },
  );

  it(mode + ": retains the draft across a routes failure and saves the selected event after recovery", async () => {
    const harness = setup(mode);
    await openEditor(harness, mode);
    await harness.user.click(screen.getByRole("checkbox"));
    harness.state.routesFailure = 500;
    await act(async () => {
      await harness.client.refetchQueries({ queryKey: messageSourceKeys.routesAll("ws1") });
    });
    expect(screen.getByRole("checkbox")).toBeChecked();
    harness.state.routesFailure = null;
    await act(async () => {
      await harness.client.refetchQueries({ queryKey: messageSourceKeys.routesAll("ws1") });
    });
    const save = screen.getByRole("button", { name: SAVE });
    expect(save).toBeEnabled();
    await harness.user.click(save);
    await waitFor(() => expect(harness.createRequests).toHaveBeenCalledTimes(1));
    expect(harness.createRequests).toHaveBeenCalledWith(expect.objectContaining({
      event_types: [mode === "team" ? "status_changed" : "issue_assigned"],
      ...(mode === "team" ? { target_chat_id: "oc_team" } : {}),
    }));
  });

  it(mode + ": restores a selection made before the catalog refresh failed and saves it after Reload", async () => {
    const harness = setup(mode);
    await openEditor(harness, mode);
    await harness.user.click(screen.getByRole("checkbox"));
    harness.state.catalogFailed = true;
    await act(async () => {
      await harness.client.refetchQueries({ queryKey: messageSourceKeys.catalog("ws1") });
    });
    await screen.findByText(CATALOG_ERROR);
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();
    harness.state.catalogFailed = false;
    await harness.user.click(screen.getByRole("button", { name: /^reload$/i }));
    expect(await screen.findByRole("checkbox")).toBeChecked();
    await harness.user.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() => expect(harness.createRequests).toHaveBeenCalledTimes(1));
    expect(harness.createRequests).toHaveBeenCalledWith(expect.objectContaining({
      event_types: [mode === "team" ? "status_changed" : "issue_assigned"],
    }));
  });
}
