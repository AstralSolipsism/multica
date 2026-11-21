import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { notificationPreferenceKeys } from "@multica/core/notification-preferences/queries";
import enSettings from "../../locales/en/settings.json";
import enMessageDelivery from "../../locales/en/message-delivery.json";
import { NotificationsTab } from "./notifications-tab";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-a" }));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-a", name: "Acme" }),
  useWorkspacePaths: () => ({ inbox: () => "/acme/inbox" }),
}));
const mutateMock = vi.hoisted(() => vi.fn());
vi.mock("../../navigation", () => ({
  AppLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@multica/core/notification-preferences/mutations", () => ({
  useUpdateNotificationPreferences: () => ({ mutate: mutateMock }),
}));
vi.mock("./browser-notification-setting", () => ({ BrowserNotificationSetting: () => null }));
vi.mock("../../you-should-know/settings/personal-toggle", () => ({
  YouShouldKnowPersonalRow: () => null,
}));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: "member", isLoading: false }),
}));
vi.mock("../../message-delivery", async () => ({
  PersonalFeishuPushSection: () => <div>personal push section</div>,
  TeamSubscriptionsSection: (await import("../../message-delivery/components/team-subscriptions-section")).TeamSubscriptionsSection,
}));

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

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

describe("Inbox notification settings", () => {
  it("groups the events by how they reach you", () => {
    renderTab({ updates: "muted" });
    const inbox = screen.getByRole("region", { name: "Inbox" });
    const lines = Array.from(
      inbox.querySelectorAll("[data-settings-anchor] .font-medium, .text-caption.font-medium"),
      (el) => el.textContent,
    );
    expect(lines).toEqual([
      "About you",
      "Assignments",
      "Mentions",
      "Reactions",
      "Issues you subscribe to",
      "Other people's issues",
      "Status changes",
      "Comments",
      "Priority & Due date",
      "Projects you subscribe to",
      "New issues",
      "Agents",
      "Agent activity",
    ]);
    expect(within(inbox).getByRole("switch", { name: "Priority & Due date" })).not.toBeChecked();
    expect(within(inbox).getByRole("switch", { name: "Comments" })).toBeChecked();
  });

  it("leaves status changes off until you turn them on", async () => {
    const user = userEvent.setup();
    renderTab();
    const statusChanges = within(screen.getByRole("region", { name: "Inbox" })).getByRole("switch", {
      name: "Status changes",
    });
    expect(statusChanges).not.toBeChecked();

    await user.click(statusChanges);
    expect(mutate).toHaveBeenCalledWith({ status_changes: "all" }, expect.anything());
  });

  it("shows status changes on once you turned them on", () => {
    renderTab({ status_changes: "all" });
    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(inbox).getByRole("switch", { name: "Status changes" })).toBeChecked();
  });

  it.each<{ preferences: Record<string, string>; shown: string }>([
    { preferences: {}, shown: "Key updates only" },
    { preferences: { others_issues: "key_updates" }, shown: "Key updates only" },
    { preferences: { others_issues: "all" }, shown: "All activity" },
  ])("shows how much of other people's issues reaches you: %j", ({ preferences, shown }) => {
    renderTab(preferences);
    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(inbox).getByRole("combobox", { name: "Other people's issues" })).toHaveTextContent(shown);
  });

  it("explains how notifications leave the Inbox, with a way to the archived ones", () => {
    renderTab();
    const leaving = screen.getByRole("region", { name: "Leaving the Inbox" });
    expect(leaving).toHaveTextContent("Reading a notification doesn't take it out of the Inbox.");
    expect(leaving).toHaveTextContent("Issues others complete stay in your Inbox.");
    expect(within(leaving).getByRole("link", { name: "View archived" })).toHaveAttribute(
      "href",
      "/acme/inbox?view=archived",
    );
  });

  it.each<{ preferences: Record<string, string>; checked: boolean }>([
    { preferences: {}, checked: true },
    { preferences: { auto_archive_completed: "muted" }, checked: false },
  ])("toggles archiving issues you complete: %j", ({ preferences, checked }) => {
    renderTab(preferences);
    const leaving = screen.getByRole("region", { name: "Leaving the Inbox" });
    const toggle = within(leaving).getByRole("switch", { name: "Archive issues you complete" });
    if (checked) expect(toggle).toBeChecked();
    else expect(toggle).not.toBeChecked();
  });
});

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
    expect(screen.getByRole("heading", { name: "Team event subscriptions" })).toBeInTheDocument();
    expect(screen.getByText(enMessageDelivery.team.description)).toBeInTheDocument();
    expect(screen.getByText(enMessageDelivery.team.admin_required)).toBeInTheDocument();
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
