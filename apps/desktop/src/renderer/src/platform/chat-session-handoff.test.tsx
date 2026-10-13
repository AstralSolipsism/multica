// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatStore, registerChatStore, useChatStore } from "@multica/core/chat";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { setCurrentWorkspace } from "@multica/core/platform";
import type { StorageAdapter } from "@multica/core/types";
import { NavigationProvider, type NavigationAdapter } from "@multica/views/navigation";
import { useTabStore } from "@/stores/tab-store";
import type { ChatSessionHandoff } from "../../../shared/chat-session-handoff";
import { DesktopChatSessionBridge, useMainWindowChatOpener } from "./chat-session-handoff";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const SESSION = "0199a4b2-1c3d-7e4f-8a5b-6c7d8e9f0a1b";

/** Installs a desktopAPI stub; `deliver()` plays what main sends. */
function stubDesktopAPI(kind: "main" | "issue") {
  let handler: ((handoff: ChatSessionHandoff) => void) | null = null;
  const onOpenChatSession = vi.fn((callback: (handoff: ChatSessionHandoff) => void) => {
    handler = callback;
    return () => {
      handler = null;
    };
  });
  const openChatSessionInMainWindow = vi.fn(async () => ({ ok: true }) as const);
  (window as unknown as { desktopAPI: Record<string, unknown> }).desktopAPI = {
    windowContext:
      kind === "main"
        ? { kind: "main" }
        : { kind: "issue", path: "/acme/issues/OL-1", workspaceSlug: "acme" },
    onOpenChatSession,
    openChatSessionInMainWindow,
  };
  return {
    onOpenChatSession,
    openChatSessionInMainWindow,
    deliver: (handoff: ChatSessionHandoff) => act(() => handler?.(handoff)),
  };
}

function navigationAt(pathname: string): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname,
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => path,
  };
}

function bridgeIn(slug: string, navigation: NavigationAdapter) {
  return (
    <WorkspaceSlugProvider slug={slug}>
      <NavigationProvider value={navigation}>
        <DesktopChatSessionBridge />
      </NavigationProvider>
    </WorkspaceSlugProvider>
  );
}

function renderBridge(navigation: NavigationAdapter) {
  return render(bridgeIn("acme", navigation));
}

/** What the shell does once a workspace switch lands: the slug moves, providers follow. */
async function land(view: ReturnType<typeof render>, slug: string, navigation: NavigationAdapter) {
  await act(async () => setCurrentWorkspace(slug, `ws-${slug}`));
  view.rerender(bridgeIn(slug, navigation));
}

/** Persisted chat state, per workspace slot. */
let values: Map<string, string>;

beforeEach(() => {
  setCurrentWorkspace("acme", "ws-1");
  useTabStore.setState({ activeWorkspaceSlug: "acme", byWorkspace: {} });
  values = new Map<string, string>();
  const storage: StorageAdapter = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  registerChatStore(createChatStore({ storage }));
});

afterEach(() => {
  cleanup();
  setCurrentWorkspace(null, null);
});

describe("DesktopChatSessionBridge (main window)", () => {
  it("opens a session of this workspace in the floating chat", () => {
    const api = stubDesktopAPI("main");
    const navigation = navigationAt("/acme/issues/OL-1");
    renderBridge(navigation);

    api.deliver({ workspaceSlug: "acme", sessionId: SESSION });

    expect(useChatStore.getState()).toMatchObject({ isOpen: true, activeSessionId: SESSION });
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("goes to the Chat page when the floating chat is off", () => {
    const api = stubDesktopAPI("main");
    useChatStore.getState().setFloatingChatEnabled(false);
    const navigation = navigationAt("/acme/issues");
    renderBridge(navigation);

    api.deliver({ workspaceSlug: "acme", sessionId: SESSION });

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/acme/chat?session=${SESSION}`);
    expect(useChatStore.getState().isOpen).toBe(false);
  });

  it("follows the session on the Chat page, where the floating chat is hidden", () => {
    const api = stubDesktopAPI("main");
    const navigation = navigationAt("/acme/chat");
    renderBridge(navigation);

    api.deliver({ workspaceSlug: "acme", sessionId: SESSION });

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/acme/chat?session=${SESSION}`);
  });

  it("switches to another workspace's session, then opens it in the floating chat there", async () => {
    const api = stubDesktopAPI("main");
    const view = renderBridge(navigationAt("/acme/issues"));

    api.deliver({ workspaceSlug: "beta", sessionId: SESSION });
    // The window restores that workspace's tabs; nothing opens on this one.
    expect(useTabStore.getState().activeWorkspaceSlug).toBe("beta");
    expect(useChatStore.getState()).toMatchObject({ isOpen: false, activeSessionId: null });

    const there = navigationAt("/beta/issues");
    await land(view, "beta", there);

    expect(useChatStore.getState()).toMatchObject({ isOpen: true, activeSessionId: SESSION });
    expect(values.get("multica:chat:activeSessionId:beta")).toBe(SESSION);
    expect(values.get("multica:chat:activeSessionId:acme")).toBeUndefined();
    expect(there.push).not.toHaveBeenCalled();
  });

  it("switches to another workspace's session, then goes to its Chat page when the floating chat is off", async () => {
    const api = stubDesktopAPI("main");
    useChatStore.getState().setFloatingChatEnabled(false);
    const view = renderBridge(navigationAt("/acme/issues"));

    api.deliver({ workspaceSlug: "beta", sessionId: SESSION });
    const there = navigationAt("/beta/issues");
    await land(view, "beta", there);

    expect(there.push).toHaveBeenCalledExactlyOnceWith(`/beta/chat?session=${SESSION}`);
    expect(useChatStore.getState().isOpen).toBe(false);
  });

  it("drops another workspace's session when the member goes somewhere else first", async () => {
    const api = stubDesktopAPI("main");
    const view = renderBridge(navigationAt("/acme/issues"));

    api.deliver({ workspaceSlug: "beta", sessionId: SESSION });
    await land(view, "gamma", navigationAt("/gamma/issues"));
    const later = navigationAt("/beta/issues");
    await land(view, "beta", later);

    expect(useChatStore.getState()).toMatchObject({ isOpen: false, activeSessionId: null });
    expect(later.push).not.toHaveBeenCalled();
  });

  it("does not listen in a dedicated issue window", () => {
    const api = stubDesktopAPI("issue");
    renderBridge(navigationAt("/acme/issues/OL-1"));
    expect(api.onOpenChatSession).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const api = stubDesktopAPI("main");
    const { unmount } = renderBridge(navigationAt("/acme/issues"));
    unmount();
    api.deliver({ workspaceSlug: "acme", sessionId: SESSION });
    expect(useChatStore.getState().activeSessionId).toBeNull();
  });
});

describe("useMainWindowChatOpener (issue window)", () => {
  it("hands the opened session to the main window", () => {
    const api = stubDesktopAPI("issue");
    const { result } = renderHook(() => useMainWindowChatOpener("acme"), {
      wrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
    });

    result.current(SESSION);

    expect(api.openChatSessionInMainWindow).toHaveBeenCalledExactlyOnceWith({
      workspaceSlug: "acme",
      sessionId: SESSION,
    });
  });

  it.each([
    ["refused by main", () => Promise.resolve({ ok: false, reason: "untrusted_sender" })],
    ["lost over IPC", () => Promise.reject(new Error("no handler"))],
  ])("says so when the session was %s", async (_case, answer) => {
    const api = stubDesktopAPI("issue");
    api.openChatSessionInMainWindow.mockImplementation(answer as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    toastError.mockReset();
    const { result } = renderHook(() => useMainWindowChatOpener("acme"));

    await act(async () => result.current(SESSION));

    expect(toastError).toHaveBeenCalledOnce();
  });
});
