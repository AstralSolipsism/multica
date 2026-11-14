import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { notificationPreferenceKeys } from "@multica/core/notification-preferences/queries";
import enSettings from "../../locales/en/settings.json";
import enMessageDelivery from "../../locales/en/message-delivery.json";
import { NotificationsTab } from "./notifications-tab";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-a" }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "ws-a", name: "Acme" }) }));
const mutateMock = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/notification-preferences/mutations", () => ({
  useUpdateNotificationPreferences: () => ({ mutate: mutateMock }),
}));
vi.mock("./browser-notification-setting", () => ({ BrowserNotificationSetting: () => null }));
vi.mock("../../you-should-know/settings/personal-toggle", () => ({
  YouShouldKnowPersonalRow: () => null,
}));
vi.mock("../../message-delivery", () => ({
  PersonalFeishuPushSection: () => <div>personal push section</div>,
  TeamSubscriptionsSection: () => <div>team subscriptions section</div>,
}));

afterEach(cleanup);

function renderTab(preferences: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  qc.setQueryData(notificationPreferenceKeys.all("ws-a"), {
    workspace_id: "ws-a",
    preferences,
  });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider
        locale="en"
        resources={{ en: { settings: enSettings, "message-delivery": enMessageDelivery } }}
      >
        <NotificationsTab />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return qc;
}

describe("notification setting hierarchy", () => {
  it.each([
    { systemMuted: false, chatMuted: false },
    { systemMuted: false, chatMuted: true },
    { systemMuted: true, chatMuted: false },
    { systemMuted: true, chatMuted: true },
  ])("nests chat replies under system notifications: %j", ({ systemMuted, chatMuted }) => {
    const qc = renderTab({
      ...(systemMuted ? { system_notifications: "muted" } : {}),
      ...(chatMuted ? { chat_replies: "muted" } : {}),
    });
    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    const system = screen.getByRole("region", { name: "System Notifications" });
    if (systemMuted) {
      expect(within(system).queryByRole("switch", { name: "Include chat replies" })).toBeNull();
      expect(within(system).getAllByRole("switch")).toHaveLength(1);
    } else {
      const replies = within(system).getByRole("switch", { name: "Include chat replies" });
      if (chatMuted) expect(replies).not.toBeChecked();
      else expect(replies).toBeChecked();
      expect(within(system).getAllByRole("switch")).toHaveLength(2);
    }
    expect(within(system).queryByText("When an agent finishes replying in a chat.")).toBeNull();
    expect(within(system).queryByText("Enable system notifications first.")).toBeNull();
    expect(within(system).queryByText("Applies to Inbox notifications and chat replies.")).toBeNull();
    qc.clear();
  });
});

describe("NotificationsTab sections", () => {
  it("renders the personal Feishu push section", () => {
    renderTab();
    expect(screen.getByText("personal push section")).toBeInTheDocument();
  });

  it("renders the team subscriptions section next to the personal push", () => {
    renderTab();
    expect(screen.getByText("team subscriptions section")).toBeInTheDocument();
    expect(screen.getByText("personal push section")).toBeInTheDocument();
  });

  it("still toggles inbox preferences", () => {
    renderTab();
    mutateMock.mockClear();
    const toggle = screen.getAllByRole("switch", { name: "Assignments" })[0]!;
    fireEvent.click(toggle);
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0]![0]).toMatchObject({ assignments: "muted" });
  });
});
