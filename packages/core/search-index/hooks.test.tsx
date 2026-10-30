/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalSearchIndexSync } from "./hooks";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  prune: vi.fn(),
  poke: vi.fn(),
}));

vi.mock("./instance", () => ({
  getLocalSearchIndex: () => mocks,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined }),
}));

describe("useLocalSearchIndexSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("defers the first attach until the browser is idle", () => {
    let idleCallback: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 7;
    }));
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const { unmount } = renderHook(() =>
      useLocalSearchIndexSync(null, "user-1", "ws-1", "workspace"),
    );
    expect(mocks.attach).not.toHaveBeenCalled();

    act(() => idleCallback?.());
    expect(mocks.attach).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      workspaceSlug: "workspace",
    });

    unmount();
    expect(mocks.detach).toHaveBeenCalledTimes(1);
  });

  it("falls back to a bounded timer when idle callbacks are unavailable", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.useFakeTimers();

    renderHook(() => useLocalSearchIndexSync(null, "user-1", "ws-1", "workspace"));
    expect(mocks.attach).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(mocks.attach).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending idle attach without detaching another target", () => {
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", vi.fn(() => 11));
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);

    const { unmount } = renderHook(() =>
      useLocalSearchIndexSync(null, "user-1", "ws-1", "workspace"),
    );
    unmount();

    expect(cancelIdleCallback).toHaveBeenCalledWith(11);
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
  });
});
