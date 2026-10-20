// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryObserver } from "@tanstack/react-query";
import { createQueryClient } from "../query-client";
import type { GitHubAppInstallation } from "../types";

const apiMock = vi.hoisted(() => ({
  listGitHubAppInstallations: vi.fn(),
}));

vi.mock("../api", () => ({ api: apiMock }));

import { githubAppInstallationsOptions, githubKeys } from "./queries";

const outlune: GitHubAppInstallation = {
  installation_id: 202,
  account_login: "outlune",
  account_type: "Organization",
  account_avatar_url: null,
  connected: false,
};

afterEach(() => {
  apiMock.listGitHubAppInstallations.mockReset();
});

describe("githubAppInstallationsOptions", () => {
  it("sits under the workspace's GitHub key and opts out of the global staleTime", () => {
    const options = githubAppInstallationsOptions("ws-1");
    expect(options.queryKey).toEqual(["github", "ws-1", "app-installations"]);
    // `["github", wsId]` invalidation after a connect or disconnect covers it.
    expect(options.queryKey.slice(0, 2)).toEqual(githubKeys.all("ws-1"));
    expect(options.staleTime).toBe(0);
    expect(githubAppInstallationsOptions("").enabled).toBe(false);
  });

  // Open workspace B's Code page, install the App on a new account from
  // workspace A, return to B: B must offer that account for reuse instead of
  // the list cached on the first visit.
  it("re-reads the list when the page mounts again under production defaults", async () => {
    apiMock.listGitHubAppInstallations
      .mockResolvedValueOnce({ installations: [], configured: true })
      .mockResolvedValueOnce({ installations: [outlune], configured: true });
    const qc = createQueryClient();

    const firstVisit = new QueryObserver(qc, githubAppInstallationsOptions("ws-b"));
    const leave = firstVisit.subscribe(() => {});
    await vi.waitFor(() =>
      expect(firstVisit.getCurrentResult().data?.installations).toEqual([]),
    );
    leave();

    const secondVisit = new QueryObserver(qc, githubAppInstallationsOptions("ws-b"));
    const unsubscribe = secondVisit.subscribe(() => {});
    try {
      await vi.waitFor(() =>
        expect(secondVisit.getCurrentResult().data?.installations).toEqual([outlune]),
      );
      expect(apiMock.listGitHubAppInstallations).toHaveBeenCalledTimes(2);
      expect(apiMock.listGitHubAppInstallations).toHaveBeenLastCalledWith("ws-b");
    } finally {
      unsubscribe();
      qc.clear();
    }
  });

  // GitHub's install page opens in another tab; coming back to this one must
  // not decide from the list read before the install.
  it("re-reads the list when the window regains focus", async () => {
    apiMock.listGitHubAppInstallations.mockResolvedValue({ installations: [], configured: true });
    const qc = createQueryClient();
    // useQuery mounts the client in production; the focus subscription lives there.
    qc.mount();
    const observer = new QueryObserver(qc, githubAppInstallationsOptions("ws-1"));
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() =>
        expect(apiMock.listGitHubAppInstallations).toHaveBeenCalledTimes(1),
      );
      focusManager.setFocused(true);
      await vi.waitFor(() =>
        expect(apiMock.listGitHubAppInstallations).toHaveBeenCalledTimes(2),
      );
    } finally {
      unsubscribe();
      // Restore "no explicit focus state"; a forced blur would pause later fetches.
      focusManager.setFocused(undefined);
      qc.unmount();
      qc.clear();
    }
  });
});
