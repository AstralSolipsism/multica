// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

// Page-level rig for the OL-104 folder tree: selecting a folder filters the
// skill list to that subtree, Uncategorized lists placement-less skills, and
// gray (not-imported) candidates stay in the panel without entering the list.

const mocks = vi.hoisted(() => ({
  skills: [] as SkillSummary[],
  folderTree: null as SkillFolderTree | null,
  viewState: {
    sortField: "name",
    sortDirection: "asc" as string,
    hiddenColumns: [] as string[],
    filters: {
      usage: [] as string[],
      origins: [] as string[],
      agents: [] as string[],
      creators: [] as string[],
      labels: [] as string[],
    },
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
    if (key[0] === "skills") {
      return { data: mocks.skills, isLoading: false, error: null, refetch: vi.fn() };
    }
    if (key.includes("skill-folders")) {
      return { data: mocks.folderTree, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: [], isLoading: false, error: null, refetch: vi.fn() };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 48,
        end: (index + 1) * 48,
        size: 48,
      })),
    getTotalSize: () => count * 48,
  }),
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/api", () => ({ api: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({
    skillDetail: (id: string) => `/acme/skills/${id}`,
  }),
}));

vi.mock("@multica/core/workspace/queries", () => ({
  skillListOptions: () => ({ queryKey: ["skills"] }),
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
  selectSkillAssignments: () => new Map(),
}));

vi.mock("@multica/core/skills/package-queries", () => ({
  skillFolderTreeOptions: () => ({ queryKey: ["workspaces", "ws-1", "skill-folders"] }),
  invalidateSkillPackageQueries: vi.fn(),
}));

vi.mock("@multica/core/runtimes", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
  runtimeDisplayLabel: () => "runtime",
}));

vi.mock("@multica/core/workspace/avatar-url", () => ({
  resolvePublicFileUrl: (u: string | null) => u,
}));

vi.mock("@multica/core/skills/stores", () => ({
  useSkillsViewStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.viewState),
  DEFAULT_HIDDEN_COLUMNS: [],
}));

vi.mock("@multica/ui/components/common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));
vi.mock("@multica/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipContent: () => null,
}));
vi.mock("./create-skill-dialog", () => ({ CreateSkillDialog: () => null }));
vi.mock("./skill-list-toolbar", () => ({ SkillListToolbar: () => null }));
vi.mock("./skill-list-actions", () => ({
  SkillBatchToolbar: () => null,
  SkillRowActions: () => null,
}));
vi.mock("./package-import-dialog", () => ({ ImportPackageDialog: () => null }));
vi.mock("./package-rescan-dialog", () => ({ RescanPackageDialog: () => null }));
vi.mock("./package-remove-dialog", () => ({ PackageRemoveDialog: () => null }));
vi.mock("./move-skills-dialog", () => ({ MoveSkillsDialog: () => null }));

import SkillsPage from "./skills-page";

function makeSkill(id: string, name: string): SkillSummary {
  return {
    id,
    workspace_id: "ws-1",
    name,
    description: "",
    config: {},
    created_by: "user-1",
    created_at: "2026-07-28T18:11:37Z",
    updated_at: "2026-07-28T18:14:40Z",
  };
}

const folderTree: SkillFolderTree = {
  folders: [
    {
      id: "f-eng",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Engineering",
      package_id: "p1",
      package_path: "",
      created_at: "",
      updated_at: "",
    },
    {
      id: "f-eng-fe",
      workspace_id: "ws-1",
      parent_id: "f-eng",
      name: "Frontend",
      package_id: "p1",
      package_path: "frontend",
      created_at: "",
      updated_at: "",
    },
    {
      id: "f-design",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Design",
      package_id: null,
      package_path: null,
      created_at: "",
      updated_at: "",
    },
  ],
  placements: [
    { workspace_id: "ws-1", skill_id: "placed", folder_id: "f-eng-fe", package_id: "p1", source_path: "skills/placed" },
    { workspace_id: "ws-1", skill_id: "design", folder_id: "f-design", package_id: null, source_path: null },
  ],
  packages: [
    {
      id: "p1",
      workspace_id: "ws-1",
      owner_repo: "o/r",
      subdirectory: "",
      source_url: "https://github.com/o/r/tree/main",
      ref: "main",
      root_folder_id: "f-eng",
      created_by: "user-1",
      revision: 1,
      candidates: [
        { path: "skills/placed", name: "placed", description: "" },
        { path: "skills/frontend/gray", name: "gray-skill", description: "" },
      ],
    },
  ],
};

function makeAdapter(): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/skills",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
    openInNewTab: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills = [
    makeSkill("placed", "placed-skill"),
    makeSkill("design", "design-skill"),
    makeSkill("loose", "loose-skill"),
  ];
  mocks.folderTree = folderTree;
});

describe("SkillsPage folder tree filtering", () => {
  it("lists every skill under All by default", async () => {
    renderWithI18n(
      <NavigationProvider value={makeAdapter()}>
        <SkillsPage />
      </NavigationProvider>,
    );
    expect(await screen.findByText("placed-skill")).toBeTruthy();
    expect(screen.getByText("design-skill")).toBeTruthy();
    expect(screen.getByText("loose-skill")).toBeTruthy();
  });

  it("filters the list to the selected folder's subtree", async () => {
    renderWithI18n(
      <NavigationProvider value={makeAdapter()}>
        <SkillsPage />
      </NavigationProvider>,
    );
    await userEvent.click(await screen.findByText("Engineering"));
    // placed-skill sits in Engineering/Frontend — inside the subtree.
    expect(screen.getByText("placed-skill")).toBeTruthy();
    expect(screen.queryByText("design-skill")).toBeNull();
    expect(screen.queryByText("loose-skill")).toBeNull();
  });

  it("shows only placement-less skills under Uncategorized", async () => {
    renderWithI18n(
      <NavigationProvider value={makeAdapter()}>
        <SkillsPage />
      </NavigationProvider>,
    );
    await userEvent.click(await screen.findByText("Uncategorized"));
    expect(screen.getByText("loose-skill")).toBeTruthy();
    expect(screen.queryByText("placed-skill")).toBeNull();
    expect(screen.queryByText("design-skill")).toBeNull();
  });

  it("keeps not-imported candidates in the panel, out of the skill list", async () => {
    renderWithI18n(
      <NavigationProvider value={makeAdapter()}>
        <SkillsPage />
      </NavigationProvider>,
    );
    const gray = await screen.findByText("gray-skill");
    expect(gray.closest("[aria-disabled]")).toBeTruthy();
    // The gray row is not a list row: it has no detail navigation target.
    expect(gray.closest("[data-row-link]")).toBeNull();
    expect(screen.getByText("Not imported")).toBeTruthy();
  });

  it("still renders the list when the tree is unreadable", async () => {
    mocks.folderTree = null;
    renderWithI18n(
      <NavigationProvider value={makeAdapter()}>
        <SkillsPage />
      </NavigationProvider>,
    );
    expect(await screen.findByText("placed-skill")).toBeTruthy();
    expect(screen.getByText("Folders couldn't be loaded.")).toBeTruthy();
  });
});
