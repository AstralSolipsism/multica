/**
 * OL-270 — web deep-link integration: the REAL `WebNavigationProvider` and
 * `WebScrollRestorationProvider` driving the REAL `IssueDetailRoute` +
 * `IssueDetail`, with only Next's router faked to the measured 16.3.4 timing
 * (route renders before history commits; HistoryUpdater writes history in an
 * insertion effect; the [id] page remounts on a new segment).
 *
 * The issue-detail component mocks come from the shared harness in
 * packages/views — import it FIRST so its vi.mock registrations land before
 * anything pulls the mocked modules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Must precede every other import: it owns the vi.mock registrations.
import {
  createTestQueryClient,
  hasHighlightedCommentBackground,
  mockApiObj,
  mockIssue,
  mockTimeline,
  TEST_RESOURCES,
} from "@multica/views/issues/components/issue-detail.test-harness";

import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { startTransition, useInsertionEffect, useMemo, useState } from "react";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { issueKeys } from "@multica/core/issues/queries";
import { I18nProvider } from "@multica/core/i18n/react";
import { useNavigation } from "@multica/views/navigation";
import { IssueDetailRoute } from "@multica/views/issues/components";
import { WebNavigationProvider } from "./navigation";
import {
  WebScrollRestorationProvider,
  clearViewStateEntries,
} from "./scroll-restoration";

// Fake just Next's router surface: usePathname/useSearchParams/useRouter read
// a React context the shell drives; HistoryUpdater commits the URL in an
// insertion effect, one commit after the destination renders.
const fakeNext = vi.hoisted(() => ({ Ctx: null as unknown as React.Context<any> }));
vi.mock("next/navigation", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const Ctx = React.createContext<any>(null);
  fakeNext.Ctx = Ctx;
  return {
    useRouter: () => React.useContext(Ctx).router,
    usePathname: () => React.useContext(Ctx).pathname,
    useSearchParams: () => React.useContext(Ctx).searchParams,
  };
});

type NavState = { href: string; mode: "push" | "replace" };
function HistoryUpdater({ state }: { state: NavState }) {
  useInsertionEffect(() => {
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (state.mode === "push" && current !== state.href) window.history.pushState({}, "", state.href);
    else window.history.replaceState({}, "", state.href);
  }, [state]);
  return null;
}

let adapterRef: { push: (p: string) => void; hash: string } | null = null;
function NavProbe() {
  adapterRef = useNavigation() as never;
  return null;
}
// A navigation channel that bypasses the adapter (R5): real apps navigate
// outside it only via the browser (back/forward, address bar).
const routerDirect = { push: (_h: string) => {} };

function FakeNextApp({ initialHref }: { initialHref: string }) {
  const [state, setState] = useState<NavState>({ href: initialHref, mode: "replace" });
  const router = useMemo(
    () => ({
      push: (href: string) => startTransition(() => setState({ href, mode: "push" })),
      replace: (href: string) => startTransition(() => setState({ href, mode: "replace" })),
      back: () => {},
      forward: () => {},
      prefetch: () => {},
    }),
    [],
  );
  routerDirect.push = router.push;
  const u = new URL(state.href, "http://localhost");
  const searchParams = new URLSearchParams(u.search);
  const routeId = u.pathname.split("/").pop()!;
  const Ctx = fakeNext.Ctx;
  return (
    <>
      <HistoryUpdater state={state} />
      <Ctx.Provider value={{ router, pathname: u.pathname, searchParams }}>
        <WebNavigationProvider>
          <WebScrollRestorationProvider>
            <NavProbe />
            <IssueDetailRoute key={routeId} routeId={routeId} />
          </WebScrollRestorationProvider>
        </WebNavigationProvider>
      </Ctx.Provider>
    </>
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
const url = () => window.location.pathname + window.location.hash;
const landed = () => hasHighlightedCommentBackground(document.getElementById("comment-b"));

function renderApp(qc: QueryClient, initialHref: string) {
  window.history.replaceState({}, "", initialHref);
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        <FakeNextApp initialHref={initialHref} />
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
async function onParent(hash = "#comment-b") {
  // The post-rewrite, remounted page: URL settled to the identifier spelling.
  await waitFor(() => expect(url()).toBe(`/test/issues/TES-2${hash}`));
  await waitFor(() => expect(document.getElementById("comment-b")).not.toBeNull());
}
async function waitLanded() {
  await waitFor(() => expect(landed()).toBe(true), { timeout: 1500 });
}
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("issue deep links under measured Next 16.3.4 timing (real adapters)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const p of ["/test/issues/TES-1", "/test/issues/TES-2", `/test/issues/${P_UUID}`]) {
      clearViewStateEntries(p, "");
    }
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

  it("AC1 first source jump (UUID URL + canonical rewrite), parent cached — the REMOUNTED page lands", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderApp(qc, "/test/issues/TES-1");
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
    // The arrival landing owns a flat timeline (no Virtuoso instance).
    expect(screen.queryByTestId("virtuoso-mock")).toBeNull();
  });

  it("AC1 second source jump (UUID URL), parent cached both times", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderApp(qc, "/test/issues/TES-1");
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
    await sleep(2700); // let the first flash fade
    await act(async () => adapterRef!.push("/test/issues/TES-1"));
    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
  }, 15000);

  it("AC1 second source jump (UUID URL), parent cached but timeline evicted", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderApp(qc, "/test/issues/TES-1");
    await onSubtask();
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
    await sleep(2700);
    await act(async () => adapterRef!.push("/test/issues/TES-1"));
    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await onSubtask();
    qc.removeQueries({ queryKey: issueKeys.timeline(P_UUID) });
    await act(async () => adapterRef!.push(`/test/issues/${P_UUID}#comment-b`));
    await onParent();
    await waitLanded();
  }, 15000);

  it("AC2 second click on an identifier link also lands again", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderApp(qc, "/test/issues/TES-1");
    await onSubtask();
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    await waitLanded();
    await sleep(2700);
    await act(async () => adapterRef!.push("/test/issues/TES-1"));
    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await onSubtask();
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    await waitLanded();
  }, 15000);

  it("AC5 a hash page pushed to a hashless issue never carries the fragment over", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderApp(qc, "/test/issues/TES-1");
    await onSubtask();
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    await waitLanded();

    await act(async () => adapterRef!.push("/test/issues/TES-1"));

    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await waitFor(() => expect(document.getElementById("comment-comment-1")).not.toBeNull());
    // Virtualized browsing resumes, nothing highlighted — the previous page's
    // fragment never leaked into this one.
    expect(screen.getByTestId("virtuoso-mock")).toBeInTheDocument();
    expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-1"))).toBe(false);
    expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-2"))).toBe(false);
  });

  it("a pending record dies with its navigation — a later non-adapter visit reports no stale fragment", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderApp(qc, "/test/issues/TES-1");
    await onSubtask();
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await onParent();
    // Re-click the same URL: Next dedupes the navigation, the record's `from`
    // premise survives the no-op commit — the address bar still shows it…
    await act(async () => adapterRef!.push("/test/issues/TES-2#comment-b"));
    await sleep(50);
    // …but any real navigation away invalidates the record for good.
    await act(async () => routerDirect.push("/test/issues/TES-1"));
    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await act(async () => routerDirect.push("/test/issues/TES-2"));
    await waitFor(() => expect(url()).toBe("/test/issues/TES-2"));
    await sleep(100);
    expect(adapterRef!.hash).toBe("");
  }, 15000);
});
