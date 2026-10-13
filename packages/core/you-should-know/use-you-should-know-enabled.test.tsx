/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { NotificationPreferenceResponse } from "../types";
import { useYouShouldKnowEnabled, isYouShouldKnowWorkspaceEnabled } from "./use-you-should-know-enabled";

vi.mock("../paths", () => ({
  useCurrentWorkspace: () => currentWorkspace,
}));

let currentWorkspace: {
  id: string;
  settings: Record<string, unknown>;
} | null = null;

function withPreferences(preferences: Record<string, string>): Promise<unknown> {
  // Simulates a loaded preference query.
  return Promise.resolve({ workspace_id: "ws-1", preferences });
}

describe("isYouShouldKnowWorkspaceEnabled", () => {
  // A missing key means OFF — the feature is opt-in per workspace. Both hooks
  // and the settings-search entries read this function.
  it("missing or falsy settings key → off", () => {
    expect(isYouShouldKnowWorkspaceEnabled(null)).toBe(false);
    expect(isYouShouldKnowWorkspaceEnabled(undefined)).toBe(false);
    expect(isYouShouldKnowWorkspaceEnabled({ settings: {} })).toBe(false);
    expect(isYouShouldKnowWorkspaceEnabled({ settings: { you_should_know_enabled: false } })).toBe(false);
  });

  it("explicit true → on", () => {
    expect(
      isYouShouldKnowWorkspaceEnabled({ settings: { you_should_know_enabled: true } }),
    ).toBe(true);
  });

  // Strict `=== true`: the backend (labrastroYSKEnabled) treats non-boolean
  // truthy values as off, so Boolean(...) here would fork the two gates —
  // e.g. a settings bag patched by hand would enable the UI but not the API.
  it("non-boolean truthy values → off (matches the backend gate)", () => {
    expect(
      isYouShouldKnowWorkspaceEnabled({ settings: { you_should_know_enabled: "true" } }),
    ).toBe(false);
    expect(
      isYouShouldKnowWorkspaceEnabled({ settings: { you_should_know_enabled: 1 } }),
    ).toBe(false);
  });
});

describe("useYouShouldKnowEnabled", () => {
  let qc: QueryClient;
  let getNotificationPreferences: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getNotificationPreferences = vi.fn(async () =>
      withPreferences({}),
    );
    setApiInstance({
      getNotificationPreferences,
    } as unknown as ApiClient);
    currentWorkspace = { id: "ws-1", settings: {} };
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("missing workspace key → off", async () => {
    currentWorkspace = { id: "ws-1", settings: {} };
    const { result } = renderHook(() => useYouShouldKnowEnabled(), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.personalEnabled).toBe(true));
    expect(result.current.workspaceEnabled).toBe(false);
    expect(result.current.enabled).toBe(false);
  });

  it("workspace key true → on (given personal not muted)", async () => {
    currentWorkspace = { id: "ws-1", settings: { you_should_know_enabled: true } };
    const { result } = renderHook(() => useYouShouldKnowEnabled(), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.workspaceEnabled).toBe(true));
    // Once preferences load (empty = not muted), both gates open.
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it("personal muted → off even when workspace on", async () => {
    getNotificationPreferences.mockImplementation(async () =>
      withPreferences({ you_should_know: "muted" }),
    );
    currentWorkspace = { id: "ws-1", settings: { you_should_know_enabled: true } };
    const { result } = renderHook(() => useYouShouldKnowEnabled(), {
      wrapper: Wrapper,
    });
    await waitFor(() =>
      expect(
        qc.getQueryData<NotificationPreferenceResponse>([
          "notification-preferences",
          "ws-1",
        ]),
      ).toBeDefined(),
    );
    expect(result.current.personalEnabled).toBe(false);
    expect(result.current.enabled).toBe(false);
  });

  it("no workspace → preference query never fires", async () => {
    currentWorkspace = null;
    const { result } = renderHook(() => useYouShouldKnowEnabled(), {
      wrapper: Wrapper,
    });
    await act(async () => {});
    expect(getNotificationPreferences).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
  });

  it("preferences not loaded yet → off (no bubble flash for muted users)", async () => {
    getNotificationPreferences.mockImplementation(
      () => new Promise<NotificationPreferenceResponse>(() => {}),
    );
    currentWorkspace = { id: "ws-1", settings: { you_should_know_enabled: true } };
    const { result } = renderHook(() => useYouShouldKnowEnabled(), {
      wrapper: Wrapper,
    });
    // still pending
    expect(result.current.workspaceEnabled).toBe(true);
    expect(result.current.personalEnabled).toBe(false);
    expect(result.current.enabled).toBe(false);
  });
});
