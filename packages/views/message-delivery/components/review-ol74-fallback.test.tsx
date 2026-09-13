// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";
import { MessageRouteEditorDialog } from "./route-editor-dialog";
import { SourceRouteEditorDialog } from "./source-route-editor-dialog";

const update = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "Bot" }) }));
vi.mock("@multica/core/message-delivery", () => ({
  messageSourceKeys: { routes: (wsId: string, sourceKind?: string) => ["message-sources", wsId, "routes", sourceKind ?? "all"] },
  useCreateMessageRoute: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMessageRoute: () => ({ mutateAsync: update, isPending: false }),
  useApproveMessageTarget: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateMessageSourceRoute: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMessageSourceRoute: () => ({ mutateAsync: update, isPending: false }),
  useApproveMessageSourceTarget: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api, getLarkTargetCapabilities: async () => ({
    chat_list_supported: false, message_anchor_list_supported: false,
    region: "feishu", scope_status: "not_checked", max_chat_page_size: 100, max_message_page_size: 50,
  }) } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
afterEach(() => { cleanup(); update.mockClear(); });

const commonRoute = {
  id: "route-1", workspace_id: "ws-1", autopilot_id: "ap-1", installation_id: "inst-1",
  channel_type: "feishu", target_type: "topic" as const, target_user_id: null,
  target_chat_id: "oc_a", target_message_id: "om_old", target_thread_id: "omt_old", target_key: "topic:oc_a:om_old",
  conditions: "success" as const, content_mode: "summary" as const, enabled: true, revision: 3,
  created_by: "u", updated_by: "u", effective_from: "2026-09-13T00:00:00Z",
  created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z",
};
const installations = [{ id: "inst-1", agent_id: "agent-1", status: "active" }];

it.each(["automation", "team"])("review: %s manual anchor changes must drop the old thread", async (kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = kind === "automation" ? <MessageRouteEditorDialog
    open onOpenChange={() => {}} autopilotId="ap-1" route={commonRoute}
    executionMode="run_only" installations={installations} members={[]} approvals={[]} isAdmin
  /> : <SourceRouteEditorDialog
    open onOpenChange={() => {}} mode="team"
    route={{ ...commonRoute, autopilot_id: null, source_kind: "activity", project_id: null, event_types: [], last_disabled_at: null }}
    installations={installations} approvals={[]} projects={[]}
    catalog={{ personal: { source_kind: "inbox", target_type: "member", event_types: [] }, team: [{ source_kind: "activity", events: [{ event: "status_changed", label: "Status" }] }] }}
  />;
  renderWithI18n(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  const user = userEvent.setup();
  const message = await screen.findByPlaceholderText("om_...");
  await user.clear(message);
  await user.type(message, "om_new");
  await user.click(screen.getByRole("button", { name: /^approve and save$/i }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  const payload = update.mock.calls[0]![0];
  expect(payload.target_message_id).toBe("om_new");
  expect(payload.target_thread_id, "The thread belongs to om_old; om_new was entered manually").toBeUndefined();
  client.clear();
});
