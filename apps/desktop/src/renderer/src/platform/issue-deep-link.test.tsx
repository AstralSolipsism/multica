/**
 * OL-270 — desktop deep-link integration: the REAL `DesktopNavigationProvider`
 * + REAL tab store driving the REAL `IssueDetailRoute` + `IssueDetail`. The
 * per-tab view-state adapter is a verbatim copy of
 * `tab-coordinator.createScrollRestorationAdapter` (the coordinator module
 * pulls in the whole route tree). The route id is read from the active tab
 * URL; no key on IssueDetailRoute, as in desktop's IssueDetailPage.
 *
 * The issue-detail component mocks come from the shared harness in
 * packages/views — import it FIRST so its vi.mock registrations land before
 * anything pulls the mocked modules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Must precede every other import: it owns the vi.mock registrations.
import {
  hasHighlightedCommentBackground,
  mockApiObj,
  mockIssue,
  mockTimeline,
  TEST_RESOURCES,
} from "@multica/views/issues/components/issue-detail.test-harness";

import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { issueKeys } from "@multica/core/issues/queries";
import { I18nProvider } from "@multica/core/i18n/react";
import { useNavigation } from "@multica/views/navigation";
import { ScrollRestorationProvider, type ScrollRestorationAdapter } from "@multica/views/platform";
import { IssueDetailRoute } from "@multica/views/issues/components";
import { DesktopNavigationProvider } from "@/platform/navigation";
import { useTabStore, getActiveTab, splitTabUrl, scrollMementoKey } from "@/stores/tab-store";

vi.mock("@/stores/window-overlay-store", () => ({
  useWindowOverlayStore: Object.assign(() => null, { getState: () => ({ overlay: null, open: vi.fn(), close: vi.fn() }) }),
}));

// Every landing (flat arrival or minimap jump) writes `highlight:<issue>` via
// setViewState; the "already landed" skip does not. Counting these writes is
// the landing signal here: on desktop the IssueDetail instance is reused, and
// a highlight left over from the first visit can still be on screen (the
// landing effect's cleanup cancels its fade — pre-existing, OL-303).
const landingWrites: string[] = [];
function createScrollRestorationAdapter(tabId: string): ScrollRestorationAdapter {
  const activeRouteKey = (): string | null => {
    const state = useTabStore.getState();
    const active = getActiveTab(state);
    if (!active || active.id !== tabId) return null;
    return splitTabUrl(active.url).pathname;
  };
  return {
    get(containerKey) {
      const routeKey = activeRouteKey();
      if (routeKey === null) return undefined;
      const active = getActiveTab(useTabStore.getState());
      return active?.memento.scroll[scrollMementoKey(routeKey, containerKey)];
    },
    getViewState(entryKey) {
      const routeKey = activeRouteKey();
      if (routeKey === null) return undefined;
      const active = getActiveTab(useTabStore.getState());
      return active?.memento.view[scrollMementoKey(routeKey, entryKey)];
    },
    setViewState(entryKey, value) {
      const routeKey = activeRouteKey();
      if (routeKey === null) return;
      if (value !== undefined) landingWrites.push(`${routeKey}::${entryKey}=${value}`);
      useTabStore.getState().commitViewState(tabId, routeKey, entryKey, value);
    },
  };
}

let adapterRef: { push: (p: string) => void; hash: string } | null = null;
function NavProbe() {
  adapterRef = useNavigation() as never;
  return null;
}

function DesktopShell() {
  const url = useTabStore((s) => getActiveTab(s)?.url ?? "/");
  const tabId = useTabStore((s) => getActiveTab(s)?.id ?? "");
  const memento = useMemo(() => createScrollRestorationAdapter(tabId), [tabId]);
  const routeId = splitTabUrl(url).pathname.split("/").pop()!;
  return (
    <DesktopNavigationProvider>
      <ScrollRestorationProvider adapter={memento}>
        <NavProbe />
        <IssueDetailRoute routeId={routeId} />
      </ScrollRestorationProvider>
    </DesktopNavigationProvider>
  );
}

const P_UUID = "7a4f4b62-9b0f-4e3a-9d3c-5f1d0f2a9b11";
const parentIssue: Issue = { ...mockIssue, id: P_UUID, identifier: "TES-2", title: "Parent issue" };
const parentTimeline: TimelineEntry[] = [
  ...mockTimeline.map((e) => ({ ...e, id: `p-${e.id}` })),
  { ...mockTimeline[0]!, id: "b", content: "Source comment in the parent", created_at: "2026-01-18T00:00:00Z", updated_at: "2026-01-18T00:00:00Z" },
];
const appQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 10 * 60 * 1000 }, mutations: { retry: false } } });
const landed = () => hasHighlightedCommentBackground(document.getElementById("comment-b"));
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function renderDesktop(qc: QueryClient) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        <DesktopShell />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
const seedParent = (qc: QueryClient) => {
  qc.setQueryData(issueKeys.detail("ws-1", P_UUID), parentIssue);
  qc.setQueryData(issueKeys.detail("ws-1", "TES-2"), parentIssue);
  qc.setQueryData(issueKeys.timeline(P_UUID), parentTimeline);
};
async function onSubtask() {
  await waitFor(() => expect(screen.getAllByText("Implement authentication").length).toBeGreaterThan(0));
}
async function onParent() {
  await waitFor(() => expect(document.getElementById("comment-b")).not.toBeNull());
}
async function waitLanded() {
  await waitFor(() => expect(landed()).toBe(true), { timeout: 1500 });
}

describe("issue deep links on the real desktop adapter + tab store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    landingWrites.length = 0;
    useTabStore.getState().reset();
    useTabStore.getState().switchWorkspace("test", "/test/issues/TES-1");
    Object.defineProperty(window, "desktopAPI", {
      configurable: true,
      value: {
        runtimeConfig: { ok: true, config: { appUrl: "https://app.example" } },
      },
    });
    mockApiObj.getIssue.mockImplementation((id: string) =>
      Promise.resolve(id === P_UUID || id === "TES-2" ? parentIssue : mockIssue),
    );
    mockApiObj.listTimeline.mockImplementation((issueId: string) =>
      Promise.resolve(issueId === P_UUID ? parentTimeline : mockTimeline),
    );
    mockApiObj.listIssueReactions.mockResolvedValue([]);
    mockApiObj.listIssueSubscribers.mockResolvedValue([]);
    mockApiObj.listChildIssues.mockResolvedValue({ issues: [] });
    mockApiObj.getChildIssueProgress.mockResolvedValue({ progress: [] });
    mockApiObj.getAgentTaskSnapshot.mockResolvedValue([]);
    mockApiObj.getWorkspaceWorkingAgents.mockResolvedValue([]);
    mockApiObj.listProperties.mockResolvedValue({ properties: [], total: 0 });
    mockApiObj.listIssues.mockResolvedValue({ issues: [], total: 0 });
    mockApiObj.getActiveTasksForIssue.mockResolvedValue({ tasks: [] });
    mockApiObj.listTasksByIssue.mockResolvedValue([]);
    mockApiObj.listTaskMessages.mockResolvedValue([]);
    mockApiObj.listMembers.mockResolvedValue([
      { user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" },
    ]);
    mockApiObj.listAgents.mockResolvedValue([]);
    mockApiObj.getProject.mockReset();
  });

  it("AC1 first source jump (UUID URL + canonical rewrite), parent cached", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderDesktop(qc);
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
  });

  it("AC1 second source jump (UUID URL), parent cached both times", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderDesktop(qc);
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
    await sleep(2700);
    await act(async () => adapterRef!.push("/test/issues/TES-1"));
    await onSubtask();
    landingWrites.length = 0;
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await sleep(300);
    expect(landingWrites.some((w) => w.endsWith(`highlight:${P_UUID}=b`))).toBe(true);
  }, 15000);

  it("AC1 second source jump (UUID URL), parent cached but timeline evicted", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderDesktop(qc);
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
    await sleep(2700);
    await act(async () => adapterRef!.push("/test/issues/TES-1"));
    await onSubtask();
    qc.removeQueries({ queryKey: issueKeys.timeline(P_UUID) });
    landingWrites.length = 0;
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await sleep(300);
    expect(landingWrites.some((w) => w.endsWith(`highlight:${P_UUID}=b`))).toBe(true);
  }, 15000);

  it("AC1 second source jump where the rewrite lands before the landing (record migrated then overwritten)", async () => {
    // Visits another issue through a link that also needs the canonical
    // rewrite between the two jumps, so the rewrite dedupe moves on and the
    // second rewrite genuinely happens — while the first visit's record sits
    // under the IDENTIFIER spelling. The overwrite migration must drop it.
    const qc = appQueryClient();
    seedParent(qc);
    renderDesktop(qc);
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
    await sleep(2700);
    await act(async () => adapterRef!.push("/test/issues/issue-1"));
    await onSubtask();
    qc.removeQueries({ queryKey: issueKeys.timeline(P_UUID) });
    landingWrites.length = 0;
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await sleep(300);
    expect(landingWrites.some((w) => w.endsWith(`highlight:${P_UUID}=b`))).toBe(true);
  }, 15000);

  it("AC2 second click on an identifier link also lands again", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderDesktop(qc);
    await onSubtask();
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    await waitLanded();
    await sleep(2700);
    await act(async () => adapterRef!.push("/test/issues/issue-1"));
    await onSubtask();
    qc.removeQueries({ queryKey: issueKeys.timeline(P_UUID) });
    landingWrites.length = 0;
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    await sleep(300);
    expect(landingWrites.some((w) => w.endsWith(`highlight:${P_UUID}=b`))).toBe(true);
  }, 15000);

  it("AC5 the adapter hash follows the tab URL (no fragment after leaving a #comment page)", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderDesktop(qc);
    await onSubtask();
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    await waitLanded();
    await act(async () => adapterRef!.push("/test/issues/TES-1"));
    await onSubtask();
    expect(adapterRef!.hash).toBe("");
    expect(screen.getByTestId("virtuoso-mock")).toBeInTheDocument();
  });
});
