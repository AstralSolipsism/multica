/**
 * OL-270 — `IssueDetailRoute` must read the `#comment-…` fragment from the
 * navigation adapter, not `window.location`. In-app pushes commit the URL
 * behind React's back (web: Next's HistoryUpdater writes pushState only when
 * the new page commits, and a same-page push fires no `hashchange`; desktop:
 * the renderer is a MemoryRouter over a file:// page, so `window.location`
 * never carries the fragment). Only the adapter reports the fragment of the
 * location that was actually navigated to, and re-renders when it changes.
 *
 * `./issue-detail` is stubbed: the wiring under test is the route → adapter →
 * prop handoff and the canonical rewrite, and the real IssueDetail pulls in
 * the whole timeline stack. The unmount-loop regression that needs the real
 * IssueDetail lives in `./issue-detail-route.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import type { Issue } from "@multica/core/types";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation";
import { IssueDetailRoute } from "./issue-detail-route";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/paths")>(
    "@multica/core/paths",
  );
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme", slug: "acme" }),
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

const issueDetailProps = vi.hoisted(() => ({
  current: null as { issueId: string; highlightCommentId?: string } | null,
}));

vi.mock("./issue-detail", () => ({
  IssueDetail: (props: { issueId: string; highlightCommentId?: string }) => {
    issueDetailProps.current = props;
    return null;
  },
  IssueDetailSkeleton: () => null,
  IssueNotFound: () => null,
}));

const ISSUE_A = "cb240efb-154c-42a8-ae92-42b02676feca";
const ISSUE_B = "7a4f4b62-9b0f-4e3a-9d3c-5f1d0f2a9b11";

const replace = vi.fn();
const push = vi.fn();

function adapterFor(hash: string): NavigationAdapter {
  return {
    push,
    replace,
    back: vi.fn(),
    pathname: "/acme/issues/x",
    searchParams: new URLSearchParams(),
    hash,
    getShareableUrl: (p: string) => `https://app.multica.com${p}`,
  };
}

function issue(id: string, identifier: string): Issue {
  return { id, identifier } as Issue;
}

function renderRoute(routeId: string, hash: string, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={adapterFor(hash)}>
        <IssueDetailRoute routeId={routeId} />
      </NavigationProvider>
    </QueryClientProvider>
  );
}

describe("IssueDetailRoute comment-hash handoff", () => {
  beforeEach(() => {
    replace.mockClear();
    push.mockClear();
    issueDetailProps.current = null;
    // The adapter — not the page URL — is the fragment source. jsdom's
    // location keeps an empty hash for the whole file; if the route ever reads
    // `window.location.hash` again, every assertion below sees "".
    expect(window.location.hash).toBe("");
    setApiInstance({
      getIssue: vi.fn((id: string) =>
        Promise.resolve(
          id === ISSUE_B ? issue(ISSUE_B, "TRS-135") : issue(ISSUE_A, "TRS-134"),
        ),
      ),
    } as unknown as ApiClient);
  });

  const newQueryClient = () =>
    new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });

  it("hands the adapter's #comment-… fragment to IssueDetail", async () => {
    const qc = newQueryClient();
    render(renderRoute(ISSUE_A, "#comment-c1", qc));

    await waitFor(() => expect(issueDetailProps.current?.issueId).toBe(ISSUE_A));
    expect(issueDetailProps.current?.highlightCommentId).toBe("c1");
  });

  it("ignores a fragment that is not a comment anchor", async () => {
    const qc = newQueryClient();
    render(renderRoute(ISSUE_A, "#activity", qc));

    await waitFor(() => expect(issueDetailProps.current?.issueId).toBe(ISSUE_A));
    expect(issueDetailProps.current?.highlightCommentId).toBeUndefined();
  });

  it("keeps the adapter's fragment when rewriting the UUID URL to the identifier", async () => {
    const qc = newQueryClient();
    render(renderRoute(ISSUE_A, "#comment-c1", qc));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/acme/issues/TRS-134#comment-c1"),
    );
  });

  it("follows a same-page push that only changes the fragment", async () => {
    const qc = newQueryClient();
    const { rerender } = render(renderRoute(ISSUE_A, "#comment-c1", qc));
    await waitFor(() => expect(issueDetailProps.current?.highlightCommentId).toBe("c1"));

    rerender(renderRoute(ISSUE_A, "#comment-c2", qc));

    await waitFor(() => expect(issueDetailProps.current?.highlightCommentId).toBe("c2"));
    // The canonical rewrite (routeId is still the UUID here) must carry the
    // NEW fragment, not the one the previous push had.
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/acme/issues/TRS-134#comment-c2"),
    );
  });

  it("follows a cross-page push to another issue's comment", async () => {
    const qc = newQueryClient();
    const { rerender } = render(renderRoute(ISSUE_A, "#comment-c1", qc));
    await waitFor(() => expect(issueDetailProps.current?.issueId).toBe(ISSUE_A));

    rerender(renderRoute(ISSUE_B, "#comment-b9", qc));

    await waitFor(() => expect(issueDetailProps.current?.issueId).toBe(ISSUE_B));
    expect(issueDetailProps.current?.highlightCommentId).toBe("b9");
  });

  it("drops the highlight when the destination URL carries no fragment", async () => {
    const qc = newQueryClient();
    const { rerender } = render(renderRoute(ISSUE_A, "#comment-c1", qc));
    await waitFor(() => expect(issueDetailProps.current?.highlightCommentId).toBe("c1"));

    // Push from the #comment page to another issue WITHOUT a fragment: the
    // stale fragment must not leak into the new page's highlight.
    rerender(renderRoute(ISSUE_B, "", qc));

    await waitFor(() => expect(issueDetailProps.current?.issueId).toBe(ISSUE_B));
    expect(issueDetailProps.current?.highlightCommentId).toBeUndefined();
  });
});
