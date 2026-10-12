import { act, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { notificationPreferenceKeys } from "@multica/core/notification-preferences/queries";
import type { NotificationPreferenceResponse, Workspace } from "@multica/core/types";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type { IssueTip } from "@multica/core/you-should-know";
import { NavigationProvider, type NavigationAdapter } from "../navigation";
import { YouShouldKnowProvider } from "../you-should-know";
import { TIP_SYNC_SETTLE_MS } from "../you-should-know/bubble/tip-bubble-host";
import { renderWithI18n } from "./i18n";

// Shared harness for the You-should-know provider suites (OL-194). Each suite
// still mocks `@multica/core/api` (the tips request), `@multica/core/auth`
// and actor names itself — vi.mock is per file.

export const WS_ID = "ws-1";
export const WS_SLUG = "acme";

export function makeTip(overrides: Partial<IssueTip> = {}): IssueTip {
  return {
    id: "tip-1",
    workspace_id: WS_ID,
    issue_id: "issue-1",
    issue_identifier: "OL-1",
    task_id: "task-1",
    agent_id: "agent-1",
    anchor_comment_id: null,
    tag: "you_should_know",
    line: "The agent put the feature behind a flag",
    title: null,
    explanation: null,
    status: "valid",
    overturned_by_task_id: null,
    overturned_by_comment_id: null,
    overturned_reason: null,
    user_state: null,
    created_at: "2026-10-11T08:00:00Z",
    updated_at: "2026-10-11T08:00:00Z",
    ...overrides,
  };
}

/**
 * A QueryClient seeded with the two switches the provider reads: the
 * workspace setting (in the workspace list) and the personal preference.
 * Tips are NOT seeded — they come from the mocked API, so a suite can assert
 * whether the request was made at all.
 */
export function createYskQueryClient({
  workspaceEnabled = true,
  personal = "all",
}: {
  workspaceEnabled?: boolean;
  personal?: "all" | "muted";
} = {}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const workspace: Workspace = {
    id: WS_ID,
    name: "Acme",
    slug: WS_SLUG,
    description: null,
    context: null,
    settings: workspaceEnabled ? { you_should_know_enabled: true } : {},
    repos: [],
    issue_prefix: "OL",
    avatar_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  client.setQueryData(workspaceKeys.list(), [workspace]);
  client.setQueryData<NotificationPreferenceResponse>(
    notificationPreferenceKeys.all(WS_ID),
    { workspace_id: WS_ID, preferences: { you_should_know: personal } },
  );
  return client;
}

export function createNavigation(
  overrides: Partial<NavigationAdapter> = {},
): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: `/${WS_SLUG}/issues`,
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.example${path}`,
    ...overrides,
  };
}

export interface YskRenderResult extends Omit<RenderResult, "rerender"> {
  queryClient: QueryClient;
  navigation: NavigationAdapter;
  /** Re-renders inside the same providers. */
  rerender: (next: ReactElement) => void;
}

export function renderWithYsk(
  ui: ReactElement,
  {
    queryClient = createYskQueryClient(),
    navigation = createNavigation(),
  }: { queryClient?: QueryClient; navigation?: NavigationAdapter } = {},
): YskRenderResult {
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={queryClient}>
      <WorkspaceSlugProvider slug={WS_SLUG}>
        <NavigationProvider value={navigation}>
          <YouShouldKnowProvider>{node}</YouShouldKnowProvider>
        </NavigationProvider>
      </WorkspaceSlugProvider>
    </QueryClientProvider>
  );
  const view = renderWithI18n(wrap(ui));
  return {
    ...view,
    queryClient,
    navigation,
    rerender: (next: ReactElement) => view.rerender(wrap(next)),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/**
 * Flushes effects and the tips query, lets the provider's re-scheduling
 * settle window pass (TIP_SYNC_SETTLE_MS on the fake clock), then flushes
 * floating-ui's async positioning.
 */
export async function settle(): Promise<void> {
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TIP_SYNC_SETTLE_MS);
  });
  await flush();
}

/** Moves the fake clock forward (dwell timers, animation frames). */
export async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * jsdom has no layout. Elements inside a `[data-test-rect="left,top,width,height"]`
 * box report that box; everything else is zero-sized. Also gives the viewport
 * a size, which floating-ui's `hide()` measures against.
 */
export function mockLayout(): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: 800,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const box = this.closest<HTMLElement>("[data-test-rect]");
      if (!box?.dataset.testRect) return new DOMRect(0, 0, 0, 0);
      const [left = 0, top = 0, width = 0, height = 0] = box.dataset.testRect
        .split(",")
        .map(Number);
      return new DOMRect(left, top, width, height);
    },
  );
}

/** The page's bubble root, or null. */
export function getBubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-ysk-bubble]");
}
