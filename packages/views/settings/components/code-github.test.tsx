import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { ApiError } from "@multica/core/api";
import { githubKeys } from "@multica/core/github";
import type {
  GitHubConnectResponse,
  ListGitHubAppInstallationsResponse,
  ListGitHubInstallationsResponse,
} from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enForkUi from "../../locales/en/fork-ui.json";
import enSettings from "../../locales/en/settings.json";

const mockListAppInstallations = vi.hoisted(() => vi.fn());
const mockGetConnectURL = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    listGitHubAppInstallations: mockListAppInstallations,
    getGitHubConnectURL: mockGetConnectURL,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mockToastError } }));

import { GitHubConnectButton } from "./code-github";

// The connect decision is tested against a real QueryClient: a mocked useQuery
// cannot show that TanStack keeps the last list while a query is disabled,
// refreshing, or after its refresh failed.
const LIST_KEY = githubKeys.appInstallations("workspace-1");
const INSTALL_URL = "https://github.com/apps/x";
const RESOURCES = { en: { common: enCommon, settings: enSettings, "fork-ui": enForkUi } };
const outluneList: ListGitHubAppInstallationsResponse = {
  configured: true,
  installations: [
    {
      installation_id: 202,
      account_login: "outlune",
      account_type: "Organization",
      account_avatar_url: null,
      connected: false,
    },
  ],
};

let qc: QueryClient;
let windowOpen: MockInstance<typeof window.open>;

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockGetConnectURL.mockResolvedValue({ configured: true, url: INSTALL_URL });
  windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  qc.clear();
  windowOpen.mockRestore();
});

function renderButton(overrides: Partial<ListGitHubInstallationsResponse> = {}) {
  const installationData: ListGitHubInstallationsResponse = {
    installations: [],
    configured: true,
    repository_browse_configured: true,
    can_manage: true,
    ...overrides,
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en" resources={RESOURCES}>
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  return render(<GitHubConnectButton installationData={installationData} />, { wrapper: Wrapper });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectGitHubInstallOpened() {
  await waitFor(() =>
    expect(windowOpen).toHaveBeenCalledWith(INSTALL_URL, "_blank", "noopener"),
  );
  expect(mockGetConnectURL).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
}

describe("GitHubConnectButton with a reusable account already cached", () => {
  beforeEach(() => {
    qc.setQueryData(LIST_KEY, outluneList);
  });

  it("offers the account once a refresh confirms it", async () => {
    mockListAppInstallations.mockResolvedValue(outluneList);
    const user = userEvent.setup();
    renderButton();
    await waitFor(() => expect(qc.getQueryState(LIST_KEY)?.fetchStatus).toBe("idle"));

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByRole("menuitem", { name: /outlune/ })).toBeInTheDocument();
    expect(mockGetConnectURL).not.toHaveBeenCalled();
  });

  it("goes to GitHub, without an error, when the refresh fails", async () => {
    mockListAppInstallations.mockRejectedValue(new ApiError("bad gateway", 502, "Bad Gateway"));
    const user = userEvent.setup();
    renderButton();
    await waitFor(() => expect(qc.getQueryState(LIST_KEY)?.status).toBe("error"));
    // TanStack still holds the old list; it must not be offered.
    expect(qc.getQueryData(LIST_KEY)).toEqual(outluneList);

    const button = screen.getByRole("button", { name: "Connect GitHub" });
    expect(button).not.toHaveAttribute("aria-haspopup");
    await user.click(button);

    await expectGitHubInstallOpened();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("waits for a refresh in flight and follows its result", async () => {
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockListAppInstallations.mockReturnValue(refresh.promise);
    const user = userEvent.setup();
    renderButton();
    await waitFor(() => expect(mockListAppInstallations).toHaveBeenCalledTimes(1));

    const button = screen.getByRole("button", { name: "Connect GitHub" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    expect(mockGetConnectURL).not.toHaveBeenCalled();

    await act(async () => refresh.resolve({ configured: true, installations: [] }));

    await expectGitHubInstallOpened();
  });

  it("ignores the cache when App credentials for reuse are missing", async () => {
    const user = userEvent.setup();
    renderButton({ repository_browse_configured: false });

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

    await expectGitHubInstallOpened();
    expect(mockListAppInstallations).not.toHaveBeenCalled();
  });

  // The trigger asks to open a frame after mousedown; refusing that request
  // must not swallow the toggle.
  it("closes the menu when its button is pressed again", async () => {
    mockListAppInstallations.mockResolvedValue(outluneList);
    const user = userEvent.setup();
    renderButton();
    await waitFor(() => expect(qc.getQueryState(LIST_KEY)?.fetchStatus).toBe("idle"));
    const button = screen.getByRole("button", { name: "Connect GitHub" });

    await user.click(button);
    await screen.findByRole("menu");
    await user.click(button);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mockGetConnectURL).not.toHaveBeenCalled();
  });

  it("opens the menu from the keyboard", async () => {
    mockListAppInstallations.mockResolvedValue(outluneList);
    const user = userEvent.setup();
    renderButton();
    await waitFor(() => expect(qc.getQueryState(LIST_KEY)?.fetchStatus).toBe("idle"));

    screen.getByRole("button", { name: "Connect GitHub" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("menuitem", { name: /outlune/ })).toBeInTheDocument();
  });
});

it("keeps the button disabled while GitHub's install URL loads, so a second click does nothing", async () => {
  qc.setQueryData(LIST_KEY, { configured: true, installations: [] });
  mockListAppInstallations.mockResolvedValue({ configured: true, installations: [] });
  const url = deferred<GitHubConnectResponse>();
  mockGetConnectURL.mockReturnValue(url.promise);
  const user = userEvent.setup();
  renderButton();
  await waitFor(() => expect(qc.getQueryState(LIST_KEY)?.fetchStatus).toBe("idle"));

  const button = screen.getByRole("button", { name: "Connect GitHub" });
  await user.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  await user.click(button);
  expect(mockGetConnectURL).toHaveBeenCalledTimes(1);

  await act(async () => url.resolve({ configured: true, url: INSTALL_URL }));
  expect(windowOpen).toHaveBeenCalledTimes(1);
  expect(button).toBeEnabled();
});
