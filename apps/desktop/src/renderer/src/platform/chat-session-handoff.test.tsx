// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatStore, registerChatStore, useChatStore } from "@multica/core/chat";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { setCurrentWorkspace } from "@multica/core/platform";
import type { StorageAdapter } from "@multica/core/types";
import { NavigationProvider, type NavigationAdapter } from "@multica/views/navigation";
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

function renderBridge(navigation: NavigationAdapter) {
  return render(
    <WorkspaceSlugProvider slug="acme">
      <NavigationProvider value={navigation}>
        <DesktopChatSessionBridge />
      </NavigationProvider>
    </WorkspaceSlugProvider>,
  );
}

beforeEach(() => {
  setCurrentWorkspace("acme", "ws-1");
  const values = new Map<string, string>();
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

  it("switches to the session's workspace when the window shows another one", () => {
    const api = stubDesktopAPI("main");
    const navigation = navigationAt("/acme/issues");
    renderBridge(navigation);

    api.deliver({ workspaceSlug: "beta", sessionId: SESSION });

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/beta/chat?session=${SESSION}`);
    expect(useChatStore.getState().activeSessionId).toBeNull();
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
