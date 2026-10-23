import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import { ApiError } from "@multica/core/api";
import type { GitHubAppInstallation, ListGitHubAppInstallationsResponse } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enForkUi from "../../locales/en/fork-ui.json";
import enSettings from "../../locales/en/settings.json";

const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockGetGitHubConnectURL = vi.hoisted(() => vi.fn());
const mockConnectInstallation = vi.hoisted(() => vi.fn());
const mockInvalidateQueries = vi.hoisted(() => vi.fn());
const mockFetchQuery = vi.hoisted(() => vi.fn());
const mockNavReplace = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const workspaceRef = vi.hoisted(() => ({
  current: {
    id: "workspace-1",
    name: "Test Workspace",
    slug: "test-workspace",
    repos: [] as { url: string; description?: string }[],
  },
}));
const roleRef = vi.hoisted(() => ({
  current: "owner" as "owner" | "admin" | "member",
}));
const githubRef = vi.hoisted(() => ({
  current: {
    installations: [] as { id: string; account_login: string }[],
    configured: true,
    repository_browse_configured: true,
    can_manage: true,
  },
}));
const githubQueryStateRef = vi.hoisted(() => ({
  current: { isPending: false, isFetching: false },
}));
// The reusable-installation query as useQuery reports it to the shared
// connect decision. code-github.test.tsx covers the same rules against a real
// QueryClient.
const appInstallationsRef = vi.hoisted(() => ({
  current: {
    status: "success" as "pending" | "error" | "success",
    data: { configured: true, installations: [] } as
      | ListGitHubAppInstallationsResponse
      | undefined,
    isFetching: false,
  },
}));
const githubRepositoriesRef = vi.hoisted(() => ({
  current: [] as {
    id: number;
    full_name: string;
    html_url: string;
    clone_url: string;
    description: string | null;
    private: boolean;
    archived: boolean;
    default_branch: string;
  }[],
}));
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams("tab=code"),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = JSON.stringify(options.queryKey);
    if (key.includes("app-installations")) return appInstallationsRef.current;
    return { data: githubRef.current, ...githubQueryStateRef.current };
  },
  useInfiniteQuery: () => ({
    data: {
      pages: [
        {
          repositories: githubRepositoriesRef.current,
          total_count: githubRepositoriesRef.current.length,
          next_page: null,
        },
      ],
    },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: mockInvalidateQueries,
    fetchQuery: mockFetchQuery,
  }),
  queryOptions: <T,>(options: T) => options,
  infiniteQueryOptions: <T,>(options: T) => options,
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({ role: roleRef.current, isLoading: false }),
}));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => workspaceRef.current,
}));
vi.mock("@multica/core/workspace/queries", () => ({
  workspaceKeys: { list: () => ["workspaces"] },
}));
vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    updateWorkspace: mockUpdateWorkspace,
    getGitHubConnectURL: mockGetGitHubConnectURL,
    connectGitHubInstallation: mockConnectInstallation,
  },
}));
vi.mock("sonner", () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: vi.fn(),
    replace: mockNavReplace,
    pathname: "/acme/settings",
    searchParams: searchParamsRef.current,
  }),
}));

import { RepositoriesSection, repositoryIdentity } from "./repositories-section";

const TEST_RESOURCES = {
  en: { common: enCommon, settings: enSettings, "fork-ui": enForkUi },
};
const APP_INSTALLATIONS_KEY = ["github", "workspace-1", "app-installations"];
const INSTALL_URL = "https://github.com/apps/multica/installations/new";

const outlune: GitHubAppInstallation = {
  installation_id: 202,
  account_login: "outlune",
  account_type: "Organization",
  account_avatar_url: null,
  connected: false,
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function offerForReuse(...installations: GitHubAppInstallation[]) {
  appInstallationsRef.current = {
    status: "success",
    data: { configured: true, installations },
    isFetching: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceRef.current = {
    id: "workspace-1",
    name: "Test Workspace",
    slug: "test-workspace",
    repos: [{ url: "https://github.com/multica-ai/multica", description: "Main app" }],
  };
  roleRef.current = "owner";
  githubRef.current = {
    installations: [],
    configured: true,
    repository_browse_configured: true,
    can_manage: true,
  };
  githubQueryStateRef.current = { isPending: false, isFetching: false };
  offerForReuse();
  githubRepositoriesRef.current = [];
  searchParamsRef.current = new URLSearchParams("tab=code");
  mockUpdateWorkspace.mockImplementation(async (_id: string, payload: object) => ({
    ...workspaceRef.current,
    ...payload,
  }));
  mockGetGitHubConnectURL.mockResolvedValue({ configured: true, url: INSTALL_URL });
  mockInvalidateQueries.mockResolvedValue(undefined);
});

async function openAddMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Add repository/ }));
}

// Pointer hover closes the submenu before user-event can move into it (Base
// UI's safe-polygon needs real layout); the keyboard path is the one the
// accessibility contract promises anyway. Focusing goes through act because
// Base UI updates menu state from the focus event.
async function openGitHubSubmenu(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
  act(() => trigger.focus());
  await user.keyboard("{ArrowRight}");
}

async function activateMenuItem(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  const item = await screen.findByRole("menuitem", { name });
  act(() => item.focus());
  await user.keyboard("{Enter}");
}

describe("RepositoriesSection", () => {
  it("lists repositories as read-only rows with their description", () => {
    render(<RepositoriesSection />, { wrapper: Wrapper });

    expect(screen.getByText("https://github.com/multica-ai/multica")).toBeInTheDocument();
    expect(screen.getByText("Main app")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("adds a repository from the dialog in one request", async () => {
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Enter a URL..." }));
    const dialog = await screen.findByRole("dialog", { name: "Add repository" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.type(
      within(dialog).getByRole("textbox", { name: "Repository URL" }),
      "git@github.com:acme/api.git",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Description" }),
      "  Go API  ",
    );
    await user.click(save);

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
        repos: [
          { url: "https://github.com/multica-ai/multica", description: "Main app" },
          { url: "git@github.com:acme/api.git", description: "Go API" },
        ],
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses a repository that is already listed under another URL form", async () => {
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Enter a URL..." }));
    const dialog = await screen.findByRole("dialog", { name: "Add repository" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Repository URL" }),
      "git@github.com:multica-ai/multica.git",
    );

    expect(within(dialog).getByText("This repository is already added.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps the dialog open with the input when saving fails", async () => {
    mockUpdateWorkspace.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: /Actions for https:\/\/github.com\/multica-ai\/multica/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit repository" });
    const description = within(dialog).getByRole("textbox", { name: "Description" });
    await user.clear(description);
    await user.type(description, "Renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"));
    expect(screen.getByRole("dialog", { name: "Edit repository" })).toBeInTheDocument();
    expect(description).toHaveValue("Renamed");
  });

  it("removes a repository only after confirmation", async () => {
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: /Actions for https:\/\/github.com\/multica-ai\/multica/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete repository" }));
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete repository",
      }),
    );

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", { repos: [] });
    });
  });

  it("hides every write affordance from members", () => {
    roleRef.current = "member";
    render(<RepositoriesSection />, { wrapper: Wrapper });

    expect(screen.queryByRole("button", { name: /Add repository/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("starts GitHub connection with the signed repository return target", async () => {
    mockGetGitHubConnectURL.mockResolvedValue({
      configured: true,
      url: "https://github.com/apps/multica/installations/new",
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: /Connect GitHub/ }));

    await waitFor(() => {
      expect(mockGetGitHubConnectURL).toHaveBeenCalledWith("workspace-1", "repositories");
      expect(open).toHaveBeenCalledWith(
        "https://github.com/apps/multica/installations/new",
        "_blank",
        "noopener",
      );
    });
    open.mockRestore();
  });

  it("explains why GitHub import is unavailable when browsing is not configured", async () => {
    githubRef.current = { ...githubRef.current, repository_browse_configured: false };
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    const item = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("GITHUB_APP_ID");
  });

  it("binds a reusable account in place and opens the picker on it", async () => {
    offerForReuse(outlune);
    mockConnectInstallation.mockResolvedValue({
      id: "inst-9",
      installation_id: 202,
      account_login: "outlune",
      account_type: "Organization",
    });
    // The invalidated installations query would report the new binding.
    mockInvalidateQueries.mockImplementation(async () => {
      githubRef.current = {
        ...githubRef.current,
        installations: [{ id: "inst-9", account_login: "outlune" }],
      };
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await openGitHubSubmenu(user);
    await activateMenuItem(user, /outlune/);

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("outlune connected"));
    expect(mockConnectInstallation).toHaveBeenCalledWith("workspace-1", 202);
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Choose GitHub repositories" });
    expect(within(dialog).getByText("outlune")).toBeInTheDocument();
    open.mockRestore();
  });

  it("still offers GitHub's install page next to the accounts it can reuse", async () => {
    offerForReuse(outlune);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await openGitHubSubmenu(user);
    await activateMenuItem(user, "Install on another GitHub account");

    await waitFor(() => {
      expect(mockGetGitHubConnectURL).toHaveBeenCalledWith("workspace-1", "repositories");
    });
    expect(open).toHaveBeenCalledWith(INSTALL_URL, "_blank", "noopener");
    expect(mockConnectInstallation).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it.each([
    [
      "the caller manages no GitHub accounts reusable here",
      () => {
        githubRef.current = { ...githubRef.current, can_manage: false };
        offerForReuse(outlune);
      },
    ],
    [
      "the reusable list failed to load, even with accounts cached",
      () => {
        appInstallationsRef.current = {
          status: "error",
          data: { configured: true, installations: [outlune] },
          isFetching: false,
        };
      },
    ],
  ])("goes straight to GitHub when %s", async (_case, arrange) => {
    arrange();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: /Connect GitHub/ }));

    await waitFor(() => {
      expect(mockGetGitHubConnectURL).toHaveBeenCalledWith("workspace-1", "repositories");
    });
    expect(open).toHaveBeenCalledWith(INSTALL_URL, "_blank", "noopener");
    expect(mockConnectInstallation).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("waits for a refresh in flight instead of offering the cached account", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await openGitHubSubmenu(user);

    // The open request was refused; the trigger shows the wait, and the
    // cached account stays hidden until the refresh decides.
    expect(screen.queryByRole("menuitem", { name: /outlune/ })).toBeNull();
    const trigger = screen.getByRole("menuitem", { name: /Connect GitHub/ });
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(mockFetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: APP_INSTALLATIONS_KEY }),
    );
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();

    const loaded = { configured: true, installations: [outlune] };
    appInstallationsRef.current = { status: "success", data: loaded, isFetching: false };
    await act(async () => refresh.resolve(loaded));

    expect(await screen.findByRole("menuitem", { name: /outlune/ })).toBeInTheDocument();
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
  });

  it("goes to GitHub when the refresh the submenu waited on comes back empty", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await openGitHubSubmenu(user);
    expect(screen.queryByRole("menuitem", { name: /outlune/ })).toBeNull();

    appInstallationsRef.current = {
      status: "success",
      data: { configured: true, installations: [] },
      isFetching: false,
    };
    await act(async () => refresh.resolve({ configured: true, installations: [] }));

    await waitFor(() => {
      expect(mockGetGitHubConnectURL).toHaveBeenCalledWith("workspace-1", "repositories");
    });
    expect(open).toHaveBeenCalledWith(INSTALL_URL, "_blank", "noopener");
    expect(screen.queryByRole("menuitem", { name: /outlune/ })).toBeNull();
    open.mockRestore();
  });

  // Base UI fires a hover open request after ~100ms at rest, so the wait has
  // to outlast it. Hovering is not confirming: the preview waits out the
  // refresh but never reaches for GitHub, whatever the refresh says.
  it("only previews on hover: no jump and no menu close when the refresh comes back empty", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    const trigger = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
    await user.hover(trigger);
    await act(() => new Promise<void>((done) => setTimeout(done, 250)));

    await waitFor(() => expect(mockFetchQuery).toHaveBeenCalled());
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("menuitem", { name: /outlune/ })).toBeNull();

    appInstallationsRef.current = {
      status: "success",
      data: { configured: true, installations: [] },
      isFetching: false,
    };
    await act(async () => refresh.resolve({ configured: true, installations: [] }));

    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    // The menu stayed open; the emptied list turned the entry back into the
    // plain item, so jumping is the user's click to make.
    expect(screen.getByRole("menuitem", { name: "Enter a URL..." })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Connect GitHub/ })).not.toHaveAttribute(
      "aria-haspopup",
    );
    open.mockRestore();
  });

  it("only previews on hover: no jump when the refresh fails", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    mockFetchQuery.mockRejectedValue(new ApiError("bad gateway", 502, "Bad Gateway"));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.hover(await screen.findByRole("menuitem", { name: /Connect GitHub/ }));
    await act(() => new Promise<void>((done) => setTimeout(done, 250)));

    await waitFor(() => expect(mockFetchQuery).toHaveBeenCalled());
    await act(() => new Promise<void>((done) => setTimeout(done, 50)));
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Enter a URL..." })).toBeInTheDocument();
    open.mockRestore();
  });

  it("opens the submenu on hover once the refresh confirms accounts", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.hover(await screen.findByRole("menuitem", { name: /Connect GitHub/ }));
    await act(() => new Promise<void>((done) => setTimeout(done, 250)));
    await waitFor(() => expect(mockFetchQuery).toHaveBeenCalled());
    expect(screen.queryByRole("menuitem", { name: /outlune/ })).toBeNull();

    const loaded = { configured: true, installations: [outlune] };
    appInstallationsRef.current = { status: "success", data: loaded, isFetching: false };
    await act(async () => refresh.resolve(loaded));

    expect(await screen.findByRole("menuitem", { name: /outlune/ })).toBeInTheDocument();
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
  });

  it("jumps to GitHub when the refresh Enter waited on comes back empty", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    const trigger = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
    act(() => trigger.focus());
    await user.keyboard("{Enter}");

    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();

    appInstallationsRef.current = {
      status: "success",
      data: { configured: true, installations: [] },
      isFetching: false,
    };
    await act(async () => refresh.resolve({ configured: true, installations: [] }));

    await waitFor(() => {
      expect(mockGetGitHubConnectURL).toHaveBeenCalledWith("workspace-1", "repositories");
    });
    expect(open).toHaveBeenCalledWith(INSTALL_URL, "_blank", "noopener");
    expect(screen.queryByRole("menuitem", { name: "Enter a URL..." })).toBeNull();
    open.mockRestore();
  });

  it("stays put when the menu was closed while the refresh was pending", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    const trigger = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockFetchQuery).toHaveBeenCalled());

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Enter a URL..." })).toBeNull(),
    );

    appInstallationsRef.current = {
      status: "success",
      data: { configured: true, installations: [] },
      isFetching: false,
    };
    await act(async () => refresh.resolve({ configured: true, installations: [] }));
    await act(() => new Promise<void>((done) => setTimeout(done, 50)));

    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("does not pop the account submenu after the menu was closed during the wait", async () => {
    offerForReuse(outlune);
    appInstallationsRef.current = { ...appInstallationsRef.current, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    const trigger = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockFetchQuery).toHaveBeenCalled());

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Enter a URL..." })).toBeNull(),
    );

    const loaded = { configured: true, installations: [outlune] };
    appInstallationsRef.current = { status: "success", data: loaded, isFetching: false };
    await act(async () => refresh.resolve(loaded));
    await act(() => new Promise<void>((done) => setTimeout(done, 50)));

    // Reopening the add menu shows the entry, not an already-open submenu.
    await user.click(screen.getByRole("button", { name: /Add repository/ }));
    expect(await screen.findByRole("menuitem", { name: /Connect GitHub/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /outlune/ })).toBeNull();
  });

  it("keeps the menu open and busy while a pending list decides, then offers the accounts", async () => {
    appInstallationsRef.current = { status: "pending", data: undefined, isFetching: true };
    const refresh = deferred<ListGitHubAppInstallationsResponse>();
    mockFetchQuery.mockReturnValue(refresh.promise);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    const item = await screen.findByRole("menuitem", { name: /Connect GitHub/ });
    await user.click(item);

    expect(item).toHaveAttribute("aria-busy", "true");
    expect(item).toHaveAttribute("aria-disabled", "true");
    // The menu stays open for the wait and its morph into the account choice.
    expect(screen.getByRole("menuitem", { name: "Enter a URL..." })).toBeInTheDocument();
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();

    const loaded = { configured: true, installations: [outlune] };
    appInstallationsRef.current = { status: "success", data: loaded, isFetching: false };
    await act(async () => refresh.resolve(loaded));

    expect(await screen.findByRole("menuitem", { name: /outlune/ })).toBeInTheDocument();
    // The plain item was replaced by the submenu trigger; focus moved with it.
    expect(screen.getByRole("menuitem", { name: /Connect GitHub/ })).toHaveFocus();
    expect(mockGetGitHubConnectURL).not.toHaveBeenCalled();
  });

  it("selects the newly bound account even when another installation sorts first", async () => {
    offerForReuse(outlune);
    mockConnectInstallation.mockResolvedValue({
      id: "inst-9",
      installation_id: 202,
      account_login: "outlune",
      account_type: "Organization",
    });
    // The invalidated installations query would report the new binding, but
    // not necessarily as the first row.
    mockInvalidateQueries.mockImplementation(async () => {
      githubRef.current = {
        ...githubRef.current,
        installations: [
          { id: "inst-1", account_login: "first-account" },
          { id: "inst-9", account_login: "outlune" },
        ],
      };
    });
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await openGitHubSubmenu(user);
    await activateMenuItem(user, /outlune/);

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("outlune connected"));
    const dialog = await screen.findByRole("dialog", { name: "Choose GitHub repositories" });
    expect(within(dialog).getByRole("combobox", { name: "GitHub account" })).toHaveTextContent(
      "outlune",
    );
  });

  it.each([
    [
      "404",
      new ApiError("github installation not found", 404, "Not Found"),
      "outlune is no longer available to reuse. It may have just been disconnected elsewhere or uninstalled on GitHub.",
      true,
    ],
    [
      "502",
      new ApiError("failed to verify github installation", 502, "Bad Gateway"),
      "Could not connect outlune. Try again.",
      false,
    ],
  ])("explains a binding refused with %s", async (_code, error, message, refreshesList) => {
    offerForReuse(outlune);
    mockConnectInstallation.mockRejectedValue(error);
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await openGitHubSubmenu(user);
    await activateMenuItem(user, /outlune/);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(message));
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Choose GitHub repositories" })).toBeNull();
    expect(
      mockInvalidateQueries.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters.queryKey) === JSON.stringify(APP_INSTALLATIONS_KEY),
      ),
    ).toBe(refreshesList);
  });

  it("imports selected GitHub repositories and deduplicates HTTPS against SSH", async () => {
    workspaceRef.current = {
      ...workspaceRef.current,
      repos: [{ url: "git@github.com:multica-ai/multica.git" }],
    };
    githubRef.current = {
      ...githubRef.current,
      installations: [{ id: "installation-row-1", account_login: "multica-ai" }],
    };
    githubRepositoriesRef.current = [
      {
        id: 1,
        full_name: "multica-ai/multica",
        html_url: "https://github.com/multica-ai/multica",
        clone_url: "https://github.com/multica-ai/multica.git",
        description: "Existing repository",
        private: false,
        archived: false,
        default_branch: "main",
      },
      {
        id: 2,
        full_name: "multica-ai/console",
        html_url: "https://github.com/multica-ai/console",
        clone_url: "https://github.com/multica-ai/console.git",
        description: "Console app",
        private: true,
        archived: false,
        default_branch: "main",
      },
    ];
    const user = userEvent.setup();
    render(<RepositoriesSection />, { wrapper: Wrapper });

    await openAddMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: /Choose from GitHub/ }));
    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(
      checkboxes[0]!.hasAttribute("disabled") ||
        checkboxes[0]!.getAttribute("aria-disabled") === "true",
    ).toBe(true);

    await user.click(checkboxes[1]!);
    await user.click(screen.getByRole("button", { name: "Add repositories" }));

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
        repos: [
          { url: "git@github.com:multica-ai/multica.git" },
          { url: "https://github.com/multica-ai/console.git", description: "Console app" },
        ],
      });
    });
  });

  it("opens the picker after returning from a GitHub connection", async () => {
    githubRef.current = {
      ...githubRef.current,
      installations: [{ id: "installation-row-1", account_login: "multica-ai" }],
    };
    searchParamsRef.current = new URLSearchParams("tab=repositories&github_connected=1");

    render(<RepositoriesSection />, { wrapper: Wrapper });

    expect(
      await screen.findByRole("heading", { name: "Choose GitHub repositories" }),
    ).toBeTruthy();
    expect(mockNavReplace).toHaveBeenCalledWith("/acme/settings?tab=repositories");
  });

  // Retrying cannot fix a refused binding or a missing installation, so these
  // codes get their own advice; any other code keeps the generic retry. The
  // two that spell out a recovery path stay until dismissed — they are the
  // only place the user reads it.
  it.each([
    ["not_authorized", enForkUi.settings.repositories.github_error_not_authorized, undefined],
    [
      "unknown_installation",
      enForkUi.settings.repositories.github_error_unknown_installation,
      undefined,
    ],
    [
      "installation_suspended",
      enForkUi.settings.repositories.github_error_installation_suspended,
      { duration: Infinity, closeButton: true },
    ],
    [
      "verification_unavailable",
      enForkUi.settings.repositories.github_error_verification_unavailable,
      { duration: Infinity, closeButton: true },
    ],
    ["persist_failed", "Could not connect GitHub. Try again.", undefined],
  ])("explains the %s install callback error", async (code, message, toastOptions) => {
    searchParamsRef.current = new URLSearchParams(`tab=github&github_error=${code}`);

    render(<RepositoriesSection />, { wrapper: Wrapper });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledTimes(1);
    const [actualMessage, actualOptions] = mockToastError.mock.calls[0] as [string, unknown];
    expect(actualMessage).toBe(message);
    expect(actualOptions).toEqual(toastOptions);
    expect(mockNavReplace).toHaveBeenCalledWith("/acme/settings?tab=github");
    expect(screen.queryByRole("heading", { name: "Choose GitHub repositories" })).toBeNull();
  });

  it("clears the GitHub callback query after an empty installation result", async () => {
    searchParamsRef.current = new URLSearchParams("tab=repositories&github_connected=1");

    render(<RepositoriesSection />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockNavReplace).toHaveBeenCalledWith("/acme/settings?tab=repositories");
    });
    expect(screen.queryByRole("heading", { name: "Choose GitHub repositories" })).toBeNull();
  });
});

describe("repositoryIdentity", () => {
  it("preserves repository path casing when comparing clone URLs", () => {
    expect(repositoryIdentity("https://GitHub.com/Acme/Repo.git")).toBe("github.com/Acme/Repo");
    expect(repositoryIdentity("git@github.com:acme/repo.git")).toBe("github.com/acme/repo");
  });

  it("keeps a non-default port, since it can name another server", () => {
    expect(repositoryIdentity("https://git.example.com:8443/acme/api.git")).not.toBe(
      repositoryIdentity("https://git.example.com:9443/acme/api.git"),
    );
    expect(repositoryIdentity("https://git.example.com:443/acme/api.git")).toBe(
      repositoryIdentity("git@git.example.com:acme/api.git"),
    );
    expect(repositoryIdentity("ssh://git@git.example.com:22/acme/api.git")).toBe(
      repositoryIdentity("git@git.example.com:acme/api.git"),
    );
  });
});
