// @vitest-environment jsdom

// OL-1030: agents-page folder explorer — hierarchy view with custom + squad
// folders, flat view on search/filter/archived scope, URL location, move
// permission gates, and squad-change reflection.

import React, { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportedLocale } from "@multica/core/i18n";
import type { Agent } from "@multica/core/types";
import type { AgentFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const apiMock = vi.hoisted(() => ({
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(),
  setAgentPlacement: vi.fn(),
  setAgentSquadPlacement: vi.fn(),
  archiveAgent: vi.fn(),
  restoreAgent: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  agents: [] as Agent[],
  folderTree: null as AgentFolderTree | null | undefined,
  folderTreeError: false,
  folderTreeFailures: 0,
  refetchTree: vi.fn(),
  currentUserId: "user-1",
  members: [] as { user_id: string; role: string }[],
  virtualizerCount: 0,
  viewState: {
    scope: "all",
    sortField: "name",
    sortDirection: "asc" as string,
    hiddenColumns: [] as string[],
    filters: {
      availability: [] as string[],
      runtimes: [] as string[],
      owners: [] as string[],
      models: [] as string[],
      access: [] as string[],
    },
    setScope: vi.fn(),
    toggleSort: vi.fn(),
    setSortField: vi.fn(),
    setSortDirection: vi.fn(),
    toggleColumn: vi.fn(),
    toggleFilter: vi.fn(),
    clearFilters: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    const key = options.queryKey ?? [];
    if (key[0] === "agents") {
      return { data: mocks.agents, isLoading: false, error: null, refetch: vi.fn() };
    }
    if (key.includes("agent-folders")) {
      return {
        data: mocks.folderTree,
        isLoading: false,
        error: mocks.folderTreeError ? new Error("tree unavailable") : null,
        failureCount: mocks.folderTreeFailures,
        refetch: mocks.refetchTree,
      };
    }
    if (key[0] === "members") {
      return { data: mocks.members, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: [], isLoading: false, isPending: false, error: null, refetch: vi.fn() };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    mocks.virtualizerCount = count;
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: index,
          start: index * 64,
          end: (index + 1) * 64,
          size: 64,
        })),
      getTotalSize: () => count * 64,
    };
  },
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: mocks.currentUserId } }),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (importOriginal) => ({
  // Keep the real ApiError / errorCode so the dialogs' coded-error mapping
  // runs against the production helper; only the api client is stubbed.
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: apiMock,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    agents: () => "/acme/agents",
    newAgent: () => "/acme/agents/new",
    newAgentManual: () => "/acme/agents/new/manual",
    agentDetail: (id: string) => `/acme/agents/${id}`,
    squadDetail: (id: string) => `/acme/squads/${id}`,
  }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
  workspaceKeys: { agents: (wsId: string) => ["agents", wsId] },
}));
vi.mock("@multica/core/agents/folder-queries", () => ({
  agentFolderTreeOptions: () => ({ queryKey: ["workspaces", "ws-1", "agent-folders"] }),
  invalidateAgentFolderQueries: vi.fn(),
}));
vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
  runtimeDisplayLabel: () => "runtime",
}));
vi.mock("@multica/core/agents", () => ({
  isAgentRuntimeBound: () => true,
  agentRunCounts30dOptions: () => ({ queryKey: ["agent-run-counts"] }),
  useWorkspaceActivityMap: () => ({ byAgent: new Map(), loading: false }),
  useWorkspacePresenceMap: () => ({ byAgent: new Map(), loading: false }),
  VISIBILITY_TOOLTIP: { private: "Private", workspace: "Workspace" },
  effectiveAccessScope: () => "workspace",
  ALL_ACCESS_SCOPES: ["workspace", "specific-people", "owner-only"],
}));
vi.mock("@multica/core/agents/stores", () => ({
  useAgentsViewStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.viewState),
  AGENT_DEFAULT_HIDDEN_COLUMNS: [],
  AGENT_SCOPES: ["mine", "all", "archived"],
}));
vi.mock("@multica/core/workspace/avatar-url", () => ({
  resolvePublicFileUrl: (url: string | null) => url,
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("@multica/ui/components/common/actor-avatar", () => ({
  ActorAvatar: ({ name }: { name: string }) => (
    <span data-testid="folder-avatar">{name.slice(0, 2).toUpperCase()}</span>
  ),
}));
vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));
vi.mock("@multica/ui/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => (
    <div data-testid="skeleton" {...props} />
  ),
}));
vi.mock("../presence", () => ({ availabilityConfig: {} }));

// The upstream toolbar is stubbed with the controls the page contract needs:
// search input, scope switcher (wired through the mocked view store), and
// filter toggles. Filter state is preset per test through mocks.viewState.
vi.mock("./agent-list-toolbar", () => ({
  countActiveFilterDimensions: (filters: Record<string, string[]>) =>
    Object.values(filters).filter((values) => values.length > 0).length,
  AgentListToolbar: ({
    scope,
    onScopeChange,
    search,
    onSearchChange,
  }: {
    scope: string;
    onScopeChange: (scope: string) => void;
    search: string;
    onSearchChange: (value: string) => void;
  }) => (
    <div>
      <input
        aria-label="Search agents"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {["mine", "all", "archived"].map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={scope === value}
          onClick={() => onScopeChange(value)}
        >
          {value === "mine" ? "Mine" : value === "all" ? "All" : "Archived"}
        </button>
      ))}
    </div>
  ),
}));

import { AgentsPage } from "./agents-page";

const BASE_AGENT: Agent = {
  id: "agent-base",
  workspace_id: "ws-1",
  runtime_id: "runtime-1",
  name: "Base Agent",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "cloud",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  permission_mode: "private",
  invocation_targets: [],
  status: "idle",
  max_concurrent_tasks: 1,
  model: "claude",
  owner_id: "user-1",
  skills: [],
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

function makeAgent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return { ...BASE_AGENT, id, name, ...over };
}

const LOOSE = makeAgent("a-loose", "loose-agent");
const PLACED = makeAgent("a-placed", "placed-agent");
const LEADER = makeAgent("a-leader", "squad-leader");
const MEMBER = makeAgent("a-member", "squad-member", { owner_id: "user-2" });
const BOTH = makeAgent("a-both", "dual-agent");
const OTHER = makeAgent("a-other", "other-agent", { owner_id: "user-2" });
const ARCHIVED = makeAgent("a-archived", "archived-agent", {
  archived_at: "2026-08-01T00:00:00Z",
});

const folderTree: AgentFolderTree = {
  folders: [
    {
      id: "f-design",
      workspaceId: "ws-1",
      parentId: null,
      name: "Design",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "f-research",
      workspaceId: "ws-1",
      parentId: "f-design",
      name: "Research",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "f-eng",
      workspaceId: "ws-1",
      parentId: null,
      name: "Engineering",
      createdAt: "",
      updatedAt: "",
    },
  ],
  placements: [
    { agentId: "a-placed", folderId: "f-design" },
    { agentId: "a-both", folderId: "f-research" },
    { agentId: "a-archived", folderId: "f-design" },
  ],
  squads: [
    {
      squadId: "sq-game",
      name: "Game design",
      avatarUrl: null,
      leaderId: "a-leader",
      creatorId: "user-1",
      parentId: null,
      agentIds: ["a-leader", "a-member", "a-both"],
    },
    {
      squadId: "sq-ops",
      name: "Ops",
      avatarUrl: null,
      leaderId: "a-hidden",
      creatorId: "user-2",
      parentId: null,
      agentIds: [],
    },
    {
      // dual-agent belongs to two squads at once (M20 regression fixture).
      squadId: "sq-growth",
      name: "Growth",
      avatarUrl: null,
      leaderId: "a-leader",
      creatorId: "user-1",
      parentId: null,
      agentIds: ["a-both"],
    },
  ],
};

type NavController = {
  path: string;
  push: Mock<(path: string) => void>;
  replace: Mock<(path: string) => void>;
  back: Mock<() => void>;
};

function makeController(path: string): NavController {
  return {
    path,
    push: vi.fn<(path: string) => void>(),
    replace: vi.fn<(path: string) => void>(),
    back: vi.fn<() => void>(),
  };
}

function NavigationHarness({
  controller,
  initialPath,
  children,
}: {
  controller: NavController;
  initialPath: string;
  children: React.ReactNode;
}) {
  const [history, setHistory] = useState({ entries: [initialPath], index: 0 });
  const [, setVersion] = useState(0);
  const currentPath = history.entries[history.index]!;
  controller.path = currentPath;
  useMemo(() => {
    controller.push.mockImplementation((path: string) => {
      setHistory((previous) => ({
        entries: [...previous.entries.slice(0, previous.index + 1), path],
        index: previous.index + 1,
      }));
    });
    controller.replace.mockImplementation((path: string) => {
      setHistory((previous) => ({
        ...previous,
        entries: previous.entries.map((entry, index) =>
          index === previous.index ? path : entry,
        ),
      }));
    });
    controller.back.mockImplementation(() => {
      setHistory((previous) => ({
        ...previous,
        index: Math.max(0, previous.index - 1),
      }));
    });
    // The real store persists scope; the mock needs a render bump to make a
    // scope click visible.
    mocks.viewState.setScope.mockImplementation((scope: string) => {
      mocks.viewState.scope = scope;
      setVersion((version) => version + 1);
    });
  }, [controller]);
  const url = new URL(currentPath, "https://example.test");
  const adapter: NavigationAdapter = {
    push: controller.push,
    replace: controller.replace,
    back: controller.back,
    pathname: url.pathname,
    searchParams: new URLSearchParams(url.search),
    hash: url.hash,
    getShareableUrl: (path) => path,
    openInNewTab: vi.fn(),
  };
  return <NavigationProvider value={adapter}>{children}</NavigationProvider>;
}

function renderPage(initialPath = "/acme/agents", locale?: SupportedLocale) {
  const controller = makeController(initialPath);
  const ui = (
    <NavigationHarness controller={controller} initialPath={initialPath}>
      <AgentsPage />
    </NavigationHarness>
  );
  const result = renderWithI18n(ui, { locale });
  return { ...result, controller };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agents = [LOOSE, PLACED, LEADER, MEMBER, BOTH, OTHER, ARCHIVED];
  mocks.folderTree = folderTree;
  mocks.folderTreeError = false;
  mocks.folderTreeFailures = 0;
  mocks.refetchTree = vi.fn();
  mocks.currentUserId = "user-1";
  mocks.members = [{ user_id: "user-1", role: "member" }];
  mocks.virtualizerCount = 0;
  mocks.viewState.scope = "all";
  for (const key of Object.keys(mocks.viewState.filters) as (keyof typeof mocks.viewState.filters)[]) {
    mocks.viewState.filters[key] = [];
  }
  apiMock.createAgentFolder.mockResolvedValue({ id: "f-new" });
  apiMock.updateAgentFolder.mockResolvedValue({ id: "f-design" });
  apiMock.deleteAgentFolder.mockResolvedValue({ deleted: true });
  apiMock.setAgentPlacement.mockResolvedValue({ updated: true });
  apiMock.setAgentSquadPlacement.mockResolvedValue({ updated: true });
});

describe("AgentsPage folder hierarchy", () => {
  it("lists squad folders and custom folders above uncategorized agents at the root", async () => {
    renderPage();
    expect(await screen.findByText("loose-agent")).toBeTruthy();
    expect(screen.getByText("other-agent")).toBeTruthy();
    // Squad folder: name, Squad badge, avatar, member count.
    const squadOpen = screen.getByRole("button", { name: "Open Game design" });
    expect(squadOpen.textContent).toContain("Squad");
    expect(squadOpen.textContent).toContain("3 agents");
    expect(within(squadOpen).getByTestId("folder-avatar")).toBeTruthy();
    // Empty squad still shows, with zero members.
    expect(screen.getByRole("button", { name: "Open Ops" }).textContent).toContain("0 agents");
    expect(screen.getByRole("button", { name: "Open Design" })).toBeTruthy();
    // Placed agents and squad members are not at the root.
    for (const name of ["placed-agent", "squad-leader", "squad-member", "dual-agent"]) {
      expect(screen.queryByText(name)).toBeNull();
    }
    // Archived agents never appear in the active scopes.
    expect(screen.queryByText("archived-agent")).toBeNull();
    // Breadcrumb root is the page name.
    expect(screen.getByRole("button", { name: "Agents" })).toBeTruthy();
    // Folder rows sort above the agent rows (M07).
    const folderRow = screen
      .getByRole("button", { name: "Open Design" })
      .closest("[role='row']") as HTMLElement;
    const agentRow = screen
      .getByText("loose-agent")
      .closest("[role='row']") as HTMLElement;
    expect(
      folderRow.compareDocumentPosition(agentRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows an agent belonging to two squads in each squad folder (M20)", async () => {
    renderPage("/acme/agents?folder=sq-growth");
    expect(await screen.findByText("dual-agent")).toBeTruthy();
    expect(screen.queryByText("squad-leader")).toBeNull();
  });

  it("enters a squad folder: members, leader badge, disabled new-folder with reason", async () => {
    const { controller } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Open Game design" }));
    expect(controller.path).toBe("/acme/agents?folder=sq-game");
    expect(await screen.findByText("squad-leader")).toBeTruthy();
    expect(screen.getByText("squad-member")).toBeTruthy();
    expect(screen.getByText("dual-agent")).toBeTruthy();
    expect(screen.getByText("Leader")).toBeTruthy();
    expect(screen.queryByText("loose-agent")).toBeNull();

    const newFolder = screen.getByRole("button", { name: "New folder" });
    expect(newFolder.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Squad folders list the squad's members. Manage members on the Squads page."),
    ).toBeTruthy();
  });

  it("scopes squad-folder contents and counts to the current scope", async () => {
    mocks.viewState.scope = "mine";
    renderPage("/acme/agents?folder=sq-game");
    // MEMBER is owned by user-2: hidden in "mine", and the leader badge
    // still lands on the visible leader row.
    expect(await screen.findByText("squad-leader")).toBeTruthy();
    expect(screen.getByText("dual-agent")).toBeTruthy();
    expect(screen.queryByText("squad-member")).toBeNull();
    expect(screen.getByText("Leader")).toBeTruthy();
  });

  it("shows a placed squad member in both its squad folder and its custom folder", async () => {
    renderPage("/acme/agents?folder=f-research");
    expect(await screen.findByText("dual-agent")).toBeTruthy();
    expect(screen.queryByText("squad-leader")).toBeNull();
  });

  it("keeps detail navigation tied to the current folder", async () => {
    const { controller } = renderPage("/acme/agents?folder=sq-game");
    await userEvent.click(await screen.findByText("squad-leader"));
    expect(controller.path).toBe("/acme/agents/a-leader?folder=sq-game");
  });

  it("navigates with breadcrumbs, Up, and browser Back", async () => {
    const { controller } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Open Design" }));
    expect(controller.path).toBe("/acme/agents?folder=f-design");
    expect(await screen.findByText("placed-agent")).toBeTruthy();
    expect(screen.queryByText("dual-agent")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open Research" }));
    expect(controller.path).toBe("/acme/agents?folder=f-research");
    expect(await screen.findByText("dual-agent")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Design" }));
    expect(controller.path).toBe("/acme/agents?folder=f-design");
    await userEvent.click(screen.getByRole("button", { name: "Up one level" }));
    expect(controller.path).toBe("/acme/agents");

    await userEvent.click(screen.getByRole("button", { name: "Open Design" }));
    await act(async () => controller.back());
    expect(controller.path).toBe("/acme/agents");
    expect(await screen.findByText("loose-agent")).toBeTruthy();
  });

  it("moves Up from a nested folder to its direct parent (M11)", async () => {
    const { controller } = renderPage("/acme/agents?folder=f-research");
    await userEvent.click(await screen.findByRole("button", { name: "Up one level" }));
    expect(controller.path).toBe("/acme/agents?folder=f-design");
    expect(await screen.findByText("placed-agent")).toBeTruthy();
  });
});

describe("AgentsPage folder actions", () => {
  it("creates a folder at the current custom location", async () => {
    renderPage("/acme/agents?folder=f-design");
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Research 2");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(apiMock.createAgentFolder).toHaveBeenCalledWith("ws-1", {
        name: "Research 2",
        parentId: "f-design",
      }),
    );
  });

  it("renames, moves and deletes a custom folder from its row menu", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Rename"));
    const input = screen.getByLabelText("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "Brand");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiMock.updateAgentFolder).toHaveBeenCalledWith("ws-1", "f-design", { name: "Brand" }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Move"));
    // The move dialog offers the root and excludes the folder's own subtree.
    expect(await screen.findByRole("button", { name: "Root" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Design / Research" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Delete"));
    expect(
      await screen.findByText(
        "Its agents, subfolders, and squad folders move up one level. No agents or squads are deleted.",
        { exact: false },
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiMock.deleteAgentFolder).toHaveBeenCalledWith("ws-1", "f-design"),
    );
  });

  it("moves a squad folder into a custom folder for its creator", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Game design" }));
    expect(await screen.findByText("Open squad")).toBeTruthy();
    expect(screen.getByText("Move to...")).toBeTruthy();
    await userEvent.click(screen.getByText("Move to..."));
    // The root is a valid squad-folder destination (move back out) — M21.
    const rootOption = await screen.findByRole("button", { name: "Root" });
    expect(rootOption).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.setAgentSquadPlacement).toHaveBeenCalledWith("ws-1", "sq-game", "f-design"),
    );
  });

  it("moves a squad folder back to the root", async () => {
    const tree = {
      ...folderTree,
      squads: folderTree.squads.map((squad) =>
        squad.squadId === "sq-game" ? { ...squad, parentId: "f-design" } : squad,
      ),
    };
    mocks.folderTree = tree;
    renderPage("/acme/agents?folder=f-design");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Game design" }));
    await userEvent.click(await screen.findByText("Move to..."));
    await userEvent.click(await screen.findByRole("button", { name: "Root" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.setAgentSquadPlacement).toHaveBeenCalledWith("ws-1", "sq-game", ""),
    );
  });

  it("moves a custom folder to the chosen destination (M22)", async () => {
    renderPage("/acme/agents?folder=f-design");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Research" }));
    await userEvent.click(await screen.findByText("Move"));
    // Both the root and other custom folders are valid destinations; the
    // folder's own subtree is excluded.
    expect(await screen.findByRole("button", { name: "Root" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Design / Research" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Engineering" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.updateAgentFolder).toHaveBeenCalledWith("ws-1", "f-research", { parentId: "f-eng" }),
    );
  });

  it("opens the squad detail page from the squad folder menu", async () => {
    const { controller } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Game design" }));
    await userEvent.click(await screen.findByText("Open squad"));
    expect(controller.path).toBe("/acme/squads/sq-game");
  });

  it("greys out squad-folder moves for non-creators with the reason", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Ops" }));
    const move = await screen.findByText("Move to...");
    expect(move.closest("[data-disabled]")).toBeTruthy();
    expect(
      screen.getByText("Only the squad creator or a workspace owner/admin can move this squad folder."),
    ).toBeTruthy();
  });

  it("lets a workspace admin move another member's squad folder", async () => {
    mocks.members = [{ user_id: "user-1", role: "admin" }];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Ops" }));
    const move = await screen.findByText("Move to...");
    expect(move.closest("[data-disabled]")).toBeNull();
    await userEvent.click(move);
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Move" }).pop()!);
    await waitFor(() =>
      expect(apiMock.setAgentSquadPlacement).toHaveBeenCalledWith("ws-1", "sq-ops", "f-design"),
    );
  });
});

describe("AgentsPage move agents", () => {
  it("moves a single agent from its row menu into a custom folder", async () => {
    renderPage();
    const row = (await screen.findByText("loose-agent")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Row actions" }));
    await userEvent.click(await screen.findByText("Move to..."));
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.setAgentPlacement).toHaveBeenCalledWith("ws-1", "a-loose", "f-design"),
    );
  });

  it("uses \"also place\" wording inside squad folders and keeps squad membership", async () => {
    renderPage("/acme/agents?folder=sq-game");
    const row = (await screen.findByText("squad-leader")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Row actions" }));
    expect(await screen.findByText("Also place in folder...")).toBeTruthy();
    expect(screen.queryByText("Move to...")).toBeNull();
    await userEvent.click(screen.getByText("Also place in folder..."));
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    expect(
      screen.getByText("Squad members stay in their squad folders; this only sets their custom folder placement."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Place" }));
    await waitFor(() =>
      expect(apiMock.setAgentPlacement).toHaveBeenCalledWith("ws-1", "a-leader", "f-design"),
    );
  });

  it("explains that clearing a squad member's placement hides it from the root", async () => {
    renderPage("/acme/agents?folder=f-research");
    const row = (await screen.findByText("dual-agent")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Row actions" }));
    await userEvent.click(await screen.findByText("Move to..."));
    await userEvent.click(await screen.findByRole("button", { name: "Root" }));
    expect(
      await screen.findByText("Squad members stay in their squad folders. Without a placement they appear only there, not at the root."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.setAgentPlacement).toHaveBeenCalledWith("ws-1", "a-both", ""),
    );
  });

  it("hides the row move action for agents the caller cannot manage", async () => {
    renderPage();
    const row = (await screen.findByText("other-agent")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Row actions" }));
    // Wait for the menu to actually render before asserting absence (M04).
    await screen.findByText("Open in new tab");
    expect(screen.queryByText("Move to...")).toBeNull();
  });

  it("batch-moves selected agents and reports partial failures", async () => {
    renderPage();
    const looseRow = (await screen.findByText("loose-agent")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(looseRow).getAllByRole("button")[0]!);
    const otherRow = screen.getByText("other-agent").closest("[role='row']") as HTMLElement;
    await userEvent.click(within(otherRow).getAllByRole("button")[0]!);

    // other-agent is owned by user-2: the batch move is disabled with a reason.
    const moveButton = screen.getByRole("button", { name: "Move to folder" });
    expect(moveButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("You don't have permission to move every selected agent."),
    ).toBeTruthy();

    // Deselect the unmanageable agent, then move the rest.
    await userEvent.click(within(otherRow).getAllByRole("button")[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.setAgentPlacement).toHaveBeenCalledWith("ws-1", "a-loose", "f-design"),
    );
  });

  it("reports a partial batch failure", async () => {
    const { toast } = await import("sonner");
    apiMock.setAgentPlacement.mockReset();
    apiMock.setAgentPlacement
      .mockResolvedValueOnce({ updated: true })
      .mockRejectedValueOnce(new Error("boom"));
    mocks.currentUserId = "user-1";
    mocks.members = [{ user_id: "user-1", role: "admin" }];
    renderPage();
    for (const name of ["loose-agent", "other-agent"]) {
      const row = (await screen.findByText(name)).closest("[role='row']") as HTMLElement;
      await userEvent.click(within(row).getAllByRole("button")[0]!);
    }
    await userEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Moved 1 of 2; the rest failed."),
    );
  });
});

describe("AgentsPage move/place wording", () => {
  it("uses the place wording for the batch action inside a squad folder", async () => {
    const { toast } = await import("sonner");
    renderPage("/acme/agents?folder=sq-game");
    const leaderRow = (await screen.findByText("squad-leader")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(leaderRow).getAllByRole("button")[0]!);
    const bothRow = screen.getByText("dual-agent").closest("[role='row']") as HTMLElement;
    await userEvent.click(within(bothRow).getAllByRole("button")[0]!);

    const button = screen.getByRole("button", { name: "Place in folder" });
    expect(button).toBeTruthy();
    await userEvent.click(button);
    // The dialog follows the place wording: confirm says "Place", not "Move".
    expect(await screen.findByRole("button", { name: "Place" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    expect(
      screen.getByText("Squad members stay in their squad folders; this only sets their custom folder placement."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Place" }));
    await waitFor(() => {
      expect(apiMock.setAgentPlacement).toHaveBeenCalledWith("ws-1", "a-leader", "f-design");
      expect(apiMock.setAgentPlacement).toHaveBeenCalledWith("ws-1", "a-both", "f-design");
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("2 agents placed."),
    );
  });

  it("keeps the move wording in flat results reached from a squad folder", async () => {
    renderPage("/acme/agents?folder=sq-game");
    const search = await screen.findByRole("textbox", { name: "Search agents" });
    await userEvent.type(search, "squad");
    expect(await screen.findByText("Results from all folders")).toBeTruthy();
    const row = screen.getByText("squad-leader").closest("[role='row']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Row actions" }));
    expect(await screen.findByText("Move to...")).toBeTruthy();
    expect(screen.queryByText("Also place in folder...")).toBeNull();
  });
});

describe("AgentsPage unreadable write responses", () => {
  it("refreshes the tree and shows an indeterminate result when a folder write reads back null", async () => {
    const { invalidateAgentFolderQueries } = await import(
      "@multica/core/agents/folder-queries"
    );
    apiMock.createAgentFolder.mockResolvedValue(null);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Ghost");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText(
        "The result couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    ).toBeTruthy();
    expect(invalidateAgentFolderQueries).toHaveBeenCalled();
    expect(screen.queryByText("Couldn't save the folder. Try again.")).toBeNull();
  });

  it("counts null placement responses as unconfirmed, not failed", async () => {
    const { toast } = await import("sonner");
    const { invalidateAgentFolderQueries } = await import(
      "@multica/core/agents/folder-queries"
    );
    apiMock.setAgentPlacement.mockReset();
    apiMock.setAgentPlacement
      .mockResolvedValueOnce({ updated: true })
      .mockResolvedValueOnce(null);
    mocks.members = [{ user_id: "user-1", role: "admin" }];
    renderPage();
    for (const name of ["loose-agent", "other-agent"]) {
      const row = (await screen.findByText(name)).closest("[role='row']") as HTMLElement;
      await userEvent.click(within(row).getAllByRole("button")[0]!);
    }
    await userEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Moved 1 of 2; 1 couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidateAgentFolderQueries).toHaveBeenCalled();
  });
});

describe("AgentsPage flat view", () => {
  it("uses a flat list with paths for the archived scope", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Archived" }));
    expect(await screen.findByText("Archived agents from all folders")).toBeTruthy();
    expect(await screen.findByText("archived-agent")).toBeTruthy();
    expect(screen.getByText("Design")).toBeTruthy();
    expect(screen.queryByText("loose-agent")).toBeNull();
  });

  it("searches across folders with path hints and returns to the original folder when cleared", async () => {
    const { controller } = renderPage("/acme/agents?folder=f-design");
    const search = await screen.findByRole("textbox", { name: "Search agents" });
    await userEvent.type(search, "agent");
    expect(await screen.findByText("Results from all folders")).toBeTruthy();
    expect(screen.getByText("dual-agent")).toBeTruthy();
    // dual-agent is in a squad AND placed: both paths, first + "+1" hover.
    expect(screen.getAllByText("Design / Research").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Game design").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Growth").length).toBeGreaterThan(0);
    expect(screen.getByText("+2")).toBeTruthy();
    expect(controller.path).toBe("/acme/agents?folder=f-design");
    expect(screen.queryByRole("button", { name: "Open Design" })).toBeNull();

    await userEvent.clear(search);
    expect(await screen.findByText("placed-agent")).toBeTruthy();
    expect(screen.queryByText("dual-agent")).toBeNull();
    expect(controller.path).toBe("/acme/agents?folder=f-design");
  });

  it("enters flat view immediately when a toolbar filter is active", async () => {
    mocks.viewState.filters.models = ["claude"];
    renderPage("/acme/agents?folder=f-design");
    expect(await screen.findByText("Results from all folders")).toBeTruthy();
    expect(screen.getByText("loose-agent")).toBeTruthy();
  });

  it("keeps every agent visible with a retry when the tree cannot load", async () => {
    mocks.folderTree = null;
    mocks.folderTreeError = true;
    renderPage();
    for (const name of ["loose-agent", "placed-agent", "squad-leader", "squad-member", "dual-agent"]) {
      expect(await screen.findByText(name)).toBeTruthy();
    }
    expect(
      screen.getByText("Folders are unavailable. Showing agents in a flat list."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetchTree).toHaveBeenCalled();
  });
});

describe("AgentsPage URL fallback and squad changes", () => {
  it("falls back to the root for an unknown URL folder", async () => {
    const { controller } = renderPage("/acme/agents?folder=missing");
    await waitFor(() => expect(controller.path).toBe("/acme/agents"));
    expect(await screen.findByText("loose-agent")).toBeTruthy();
  });

  it("falls back to the nearest surviving ancestor when the current folder is deleted", async () => {
    const { controller, rerender } = renderPage("/acme/agents?folder=f-research");
    expect(await screen.findByText("dual-agent")).toBeTruthy();
    mocks.folderTree = {
      ...folderTree,
      folders: folderTree.folders.filter((folder) => folder.id !== "f-research"),
      placements: folderTree.placements.map((placement) =>
        placement.folderId === "f-research"
          ? { ...placement, folderId: "f-design" }
          : placement,
      ),
    };
    rerender(
      <NavigationHarness controller={controller} initialPath="/acme/agents?folder=f-research">
        <AgentsPage />
      </NavigationHarness>,
    );
    await waitFor(() => expect(controller.path).toBe("/acme/agents?folder=f-design"));
    expect(await screen.findByText("dual-agent")).toBeTruthy();
  });

  it("reflects squad renames and membership changes without a manual refresh", async () => {
    const { controller, rerender } = renderPage();
    expect(await screen.findByRole("button", { name: "Open Game design" })).toBeTruthy();
    mocks.folderTree = {
      ...folderTree,
      squads: folderTree.squads.map((squad) =>
        squad.squadId === "sq-game"
          ? { ...squad, name: "Game design v2", agentIds: [...squad.agentIds, "a-loose"] }
          : squad,
      ),
    };
    rerender(
      <NavigationHarness controller={controller} initialPath="/acme/agents">
        <AgentsPage />
      </NavigationHarness>,
    );
    expect(await screen.findByRole("button", { name: "Open Game design v2" })).toBeTruthy();
    // loose-agent joined the squad: it leaves the root list.
    expect(screen.queryByText("loose-agent")).toBeNull();
  });

  it("returns squad members without a placement to the root when the squad is archived", async () => {
    const { controller, rerender } = renderPage();
    expect(await screen.findByRole("button", { name: "Open Game design" })).toBeTruthy();
    mocks.folderTree = {
      ...folderTree,
      squads: folderTree.squads.filter((squad) => squad.squadId !== "sq-game"),
    };
    rerender(
      <NavigationHarness controller={controller} initialPath="/acme/agents">
        <AgentsPage />
      </NavigationHarness>,
    );
    // a-leader and a-member have no other squad and no placement: root.
    expect(await screen.findByText("squad-leader")).toBeTruthy();
    expect(screen.getByText("squad-member")).toBeTruthy();
    // a-both still has its custom placement: not at the root.
    expect(screen.queryByText("dual-agent")).toBeNull();
  });
});

describe("AgentsPage folder regressions", () => {
  it("localizes the breadcrumb root with the page title", async () => {
    renderPage("/acme/agents", "ja");
    const nav = await screen.findByRole("navigation", { name: "フォルダの場所" });
    expect(within(nav).getByRole("button", { name: "エージェント" })).toBeTruthy();
  });

  it("shows a skeleton instead of flashing the flat list while the tree loads", () => {
    mocks.folderTree = undefined;
    renderPage("/acme/agents?folder=sq-game");
    expect(screen.queryByText("squad-leader")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Game design" })).toBeNull();
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("keeps the upstream empty-workspace state when there are no agents and no folders", async () => {
    mocks.agents = [];
    mocks.folderTree = { folders: [], placements: [], squads: [] };
    renderPage();
    expect(await screen.findByText("No agents yet")).toBeTruthy();
  });

  it("limits selection and select-all to agent rows in the current folder view", async () => {
    renderPage("/acme/agents?folder=sq-game");
    const header = screen.getAllByRole("row")[0]!;
    await userEvent.click(within(header).getAllByRole("button")[0]!);
    // All three members selected; folder rows are never selectable.
    expect(await screen.findByText("3 selected")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const rootHeader = screen.getAllByRole("row")[0]!;
    await userEvent.click(within(rootHeader).getAllByRole("button")[0]!);
    // At the root only the uncategorized agents are selectable.
    expect(await screen.findByText("2 selected")).toBeTruthy();
  });
});

describe("AgentsPage unreadable folder move/delete responses", () => {
  it("refreshes the tree and shows an indeterminate result when a folder move reads back null", async () => {
    const { invalidateAgentFolderQueries } = await import(
      "@multica/core/agents/folder-queries"
    );
    apiMock.updateAgentFolder.mockResolvedValue(null);
    renderPage("/acme/agents?folder=f-design");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Research" }));
    await userEvent.click(await screen.findByText("Move"));
    await userEvent.click(await screen.findByRole("button", { name: "Engineering" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.updateAgentFolder).toHaveBeenCalledWith("ws-1", "f-research", { parentId: "f-eng" }),
    );
    expect(
      await screen.findByText(
        "The result couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    ).toBeTruthy();
    expect(invalidateAgentFolderQueries).toHaveBeenCalled();
    expect(screen.queryByText("Couldn't move the folder. Try again.")).toBeNull();
  });

  it("refreshes the tree and shows an indeterminate result when a folder delete reads back null", async () => {
    const { invalidateAgentFolderQueries } = await import(
      "@multica/core/agents/folder-queries"
    );
    apiMock.deleteAgentFolder.mockResolvedValue(null);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Delete"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiMock.deleteAgentFolder).toHaveBeenCalledWith("ws-1", "f-design"),
    );
    expect(
      await screen.findByText(
        "The result couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    ).toBeTruthy();
    expect(invalidateAgentFolderQueries).toHaveBeenCalled();
    expect(screen.queryByText("Couldn't delete the folder. Try again.")).toBeNull();
  });
});

describe("AgentsPage place-variant result toasts", () => {
  async function selectTwoSquadMembers() {
    renderPage("/acme/agents?folder=sq-game");
    const leaderRow = (await screen.findByText("squad-leader")).closest("[role='row']") as HTMLElement;
    await userEvent.click(within(leaderRow).getAllByRole("button")[0]!);
    const bothRow = screen.getByText("dual-agent").closest("[role='row']") as HTMLElement;
    await userEvent.click(within(bothRow).getAllByRole("button")[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Place in folder" }));
    await userEvent.click(await screen.findByRole("button", { name: "Design" }));
  }

  it("uses the place wording for an unconfirmed result", async () => {
    const { toast } = await import("sonner");
    apiMock.setAgentPlacement.mockReset();
    apiMock.setAgentPlacement
      .mockResolvedValueOnce({ updated: true })
      .mockResolvedValueOnce(null);
    await selectTwoSquadMembers();
    await userEvent.click(screen.getByRole("button", { name: "Place" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Placed 1 of 2; 1 couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("uses the place wording for a partial failure", async () => {
    const { toast } = await import("sonner");
    apiMock.setAgentPlacement.mockReset();
    apiMock.setAgentPlacement
      .mockResolvedValueOnce({ updated: true })
      .mockRejectedValueOnce(new Error("boom"));
    await selectTwoSquadMembers();
    await userEvent.click(screen.getByRole("button", { name: "Place" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Placed 1 of 2; the rest failed."),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("uses the place wording when every placement fails", async () => {
    const { toast } = await import("sonner");
    apiMock.setAgentPlacement.mockReset();
    apiMock.setAgentPlacement.mockRejectedValue(new Error("boom"));
    await selectTwoSquadMembers();
    await userEvent.click(screen.getByRole("button", { name: "Place" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't place the agents. Try again."),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("AgentsPage localized folder errors", () => {
  it("localizes a coded create error instead of showing the server message", async () => {
    const { ApiError } = await import("@multica/core/api");
    apiMock.createAgentFolder.mockRejectedValue(
      new ApiError("a folder with this name already exists at the destination", 409, "Conflict", {
        code: "name_conflict",
        error: "a folder with this name already exists at the destination",
      }),
    );
    renderPage("/acme/agents", "zh-Hans");
    await userEvent.click(await screen.findByRole("button", { name: "新建文件夹" }));
    await userEvent.type(screen.getByLabelText("名称"), "Research");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("目标位置已存在同名文件夹，请换一个名称。")).toBeTruthy();
    expect(screen.queryByText(/already exists at the destination/)).toBeNull();
  });

  it("localizes a coded move error", async () => {
    const { ApiError } = await import("@multica/core/api");
    apiMock.updateAgentFolder.mockRejectedValue(
      new ApiError("folder move would create a cycle", 409, "Conflict", {
        code: "folder_cycle",
        error: "folder move would create a cycle",
      }),
    );
    renderPage("/acme/agents?folder=f-design");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Research" }));
    await userEvent.click(await screen.findByText("Move"));
    await userEvent.click(await screen.findByRole("button", { name: "Engineering" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(
      await screen.findByText("A folder can't be moved into one of its own subfolders."),
    ).toBeTruthy();
    expect(screen.queryByText("folder move would create a cycle")).toBeNull();
  });

  it("localizes a coded delete error", async () => {
    const { ApiError } = await import("@multica/core/api");
    apiMock.deleteAgentFolder.mockRejectedValue(
      new ApiError("object not found in this workspace", 404, "Not Found", {
        code: "not_found",
        error: "object not found in this workspace",
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Delete"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(
        "The target couldn't be found — it may have been deleted. The list was refreshed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("object not found in this workspace")).toBeNull();
  });

  it("falls back to the generic failure copy for an uncoded error", async () => {
    apiMock.createAgentFolder.mockRejectedValue(new Error("socket hangup"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Ghost");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Couldn't save the folder. Try again.")).toBeTruthy();
    expect(screen.queryByText("socket hangup")).toBeNull();
  });
});

describe("AgentsPage tree wait fallback", () => {
  it("falls back to the flat list on the first failed tree attempt, before the retry settles", () => {
    mocks.folderTree = undefined;
    mocks.folderTreeFailures = 1;
    renderPage();
    for (const name of ["loose-agent", "placed-agent", "squad-leader", "squad-member", "dual-agent"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(
      screen.getByText("Folders are unavailable. Showing agents in a flat list."),
    ).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Design" })).toBeNull();
  });

  it("falls back to the flat list after 5s without tree data, then restores the hierarchy when it arrives", async () => {
    vi.useFakeTimers();
    try {
      mocks.folderTree = undefined;
      const { controller, rerender } = renderPage("/acme/agents?folder=sq-game");
      // Inside the grace window the skeleton shows; nothing flat flashes.
      expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
      expect(screen.queryByText("squad-leader")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText("squad-leader")).toBeTruthy();
      expect(screen.getByText("loose-agent")).toBeTruthy();
      expect(
        screen.getByText("Folders are unavailable. Showing agents in a flat list."),
      ).toBeTruthy();

      // Late data restores the hierarchy at the requested squad folder.
      mocks.folderTree = folderTree;
      rerender(
        <NavigationHarness controller={controller} initialPath="/acme/agents?folder=sq-game">
          <AgentsPage />
        </NavigationHarness>,
      );
      expect(screen.queryByText("Folders are unavailable. Showing agents in a flat list.")).toBeNull();
      expect(screen.getByText("squad-leader")).toBeTruthy();
      expect(screen.getByText("squad-member")).toBeTruthy();
      expect(screen.queryByText("loose-agent")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
