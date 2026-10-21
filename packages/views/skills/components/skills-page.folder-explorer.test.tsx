// @vitest-environment jsdom

import React, { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

const apiMock = vi.hoisted(() => ({
  createSkillFolder: vi.fn(),
  updateSkillFolder: vi.fn(),
  deleteSkillFolder: vi.fn(),
  detachSkillPlacement: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  skills: [] as SkillSummary[],
  folderTree: null as SkillFolderTree | null | undefined,
  folderTreeError: false,
  refetchTree: vi.fn(),
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
      return {
        data: mocks.folderTree,
        isLoading: false,
        error: mocks.folderTreeError ? new Error("tree unavailable") : null,
        refetch: mocks.refetchTree,
      };
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
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({
    skills: () => "/acme/skills",
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
  resolvePublicFileUrl: (url: string | null) => url,
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
vi.mock("./skill-list-toolbar", () => ({
  SkillListToolbar: ({
    search,
    onSearchChange,
    countLabel,
  }: {
    search: string;
    onSearchChange: (value: string) => void;
    countLabel?: string;
  }) => (
    <div>
      <input
        aria-label="Search skills"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {countLabel && <span>{countLabel}</span>}
    </div>
  ),
}));
vi.mock("./skill-list-actions", () => ({
  SkillBatchToolbar: () => null,
  SkillRowActions: () => null,
}));
vi.mock("./package-import-dialog", () => ({ ImportPackageDialog: () => null }));
vi.mock("./package-rescan-dialog", () => ({
  RescanPackageDialog: () => <div data-testid="rescan-dialog" />,
}));
vi.mock("./package-remove-dialog", () => ({
  PackageRemoveDialog: ({ mode }: { mode: string }) => (
    <div data-testid={`remove-dialog-${mode}`} />
  ),
}));
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
    {
      id: "f-empty",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Empty",
      package_id: null,
      package_path: null,
      created_at: "",
      updated_at: "",
    },
  ],
  placements: [
    { workspace_id: "ws-1", skill_id: "placed", folder_id: "f-eng-fe", package_id: "p1", source_path: "skills/placed" },
    { workspace_id: "ws-1", skill_id: "engineering", folder_id: "f-eng", package_id: "p1", source_path: "skills/engineering" },
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
        { path: "skills/engineering", name: "engineering", description: "" },
        { path: "skills/frontend/gray", name: "gray-skill", description: "" },
      ],
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

function renderPage(initialPath = "/acme/skills") {
  const controller = makeController(initialPath);
  const ui = (
    <NavigationHarness controller={controller} initialPath={initialPath}>
      <SkillsPage />
    </NavigationHarness>
  );
  const result = renderWithI18n(ui);
  return { ...result, controller };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills = [
    makeSkill("placed", "placed-skill"),
    makeSkill("engineering", "engineering-skill"),
    makeSkill("design", "design-skill"),
    makeSkill("loose", "loose-skill"),
  ];
  mocks.folderTree = folderTree;
  mocks.folderTreeError = false;
  mocks.refetchTree = vi.fn();
  for (const key of Object.keys(mocks.viewState.filters) as (keyof typeof mocks.viewState.filters)[]) {
    mocks.viewState.filters[key] = [];
  }
  apiMock.createSkillFolder.mockResolvedValue({ id: "new-folder" });
  apiMock.updateSkillFolder.mockResolvedValue({ id: "folder" });
  apiMock.deleteSkillFolder.mockResolvedValue({ deleted: true });
  apiMock.detachSkillPlacement.mockResolvedValue({ updated: true });
});

describe("SkillsPage folder hierarchy", () => {
  it("starts at root with only top-level folders and uncategorized skills", async () => {
    renderPage();
    expect(await screen.findByText("loose-skill")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Engineering" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Design" })).toBeTruthy();
    expect(screen.queryByText("placed-skill")).toBeNull();
    expect(screen.queryByText("engineering-skill")).toBeNull();
    expect(screen.queryByText("design-skill")).toBeNull();
    expect(screen.queryByText("gray-skill")).toBeNull();
    expect(screen.queryByText("All skills")).toBeNull();
    expect(screen.getByText("1 here / 4 in workspace")).toBeTruthy();
  });

  it("enters direct folders, follows breadcrumbs and Up, and supports browser Back", async () => {
    const { controller } = renderPage("/acme/skills?view=compact");
    await userEvent.click(await screen.findByRole("button", { name: "Open Engineering" }));
    expect(controller.path).toBe("/acme/skills?view=compact&folder=f-eng");
    expect(await screen.findByText("engineering-skill")).toBeTruthy();
    expect(screen.queryByText("placed-skill")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open Frontend" }));
    expect(controller.path).toBe("/acme/skills?view=compact&folder=f-eng-fe");
    expect(await screen.findByText("placed-skill")).toBeTruthy();
    expect(screen.queryByText("engineering-skill")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Engineering" }));
    expect(controller.path).toBe("/acme/skills?view=compact&folder=f-eng");
    await userEvent.click(screen.getByRole("button", { name: "Up one level" }));
    expect(controller.path).toBe("/acme/skills?view=compact");

    await userEvent.click(screen.getByRole("button", { name: "Open Engineering" }));
    await userEvent.click(screen.getByRole("button", { name: "Open Frontend" }));
    await act(async () => controller.back());
    expect(controller.path).toBe("/acme/skills?view=compact&folder=f-eng");
    expect(await screen.findByText("engineering-skill")).toBeTruthy();
  });

  it("shows an empty-folder state and a direct-skill count", async () => {
    renderPage("/acme/skills?folder=f-empty");
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
    expect(screen.getByText("0 here / 4 in workspace")).toBeTruthy();
  });

  it("keeps detail navigation tied to the current folder", async () => {
    const { controller } = renderPage("/acme/skills?folder=f-design");
    await userEvent.click(await screen.findByText("design-skill"));
    expect(controller.path).toBe("/acme/skills/design?folder=f-design");
  });
});

describe("SkillsPage URL fallback", () => {
  it("falls back to root for an unknown URL folder without dropping query parameters", async () => {
    const { controller } = renderPage("/acme/skills?view=compact&folder=missing");
    await waitFor(() => expect(controller.path).toBe("/acme/skills?view=compact"));
    expect(await screen.findByText("loose-skill")).toBeTruthy();
  });

  it("falls back to the nearest surviving ancestor using the previous tree", async () => {
    const { controller, rerender } = renderPage("/acme/skills?folder=f-eng-fe");
    expect(await screen.findByText("placed-skill")).toBeTruthy();
    mocks.folderTree = {
      ...folderTree,
      folders: folderTree.folders.filter((folder) => folder.id !== "f-eng-fe"),
      placements: folderTree.placements.filter((placement) => placement.folder_id !== "f-eng-fe"),
    };
    rerender(
      <NavigationHarness controller={controller} initialPath="/acme/skills?folder=f-eng-fe">
        <SkillsPage />
      </NavigationHarness>,
    );
    await waitFor(() => expect(controller.path).toBe("/acme/skills?folder=f-eng"));
    expect(await screen.findByText("engineering-skill")).toBeTruthy();
  });
});

describe("SkillsPage folder actions", () => {
  it("creates a folder at the current custom location", async () => {
    renderPage("/acme/skills?folder=f-design");
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Research");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(apiMock.createSkillFolder).toHaveBeenCalledWith("ws-1", {
        name: "Research",
        parent_id: "f-design",
      }),
    );
  });

  it("creates a root folder when no folder parameter is present", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Research");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(apiMock.createSkillFolder).toHaveBeenCalledWith("ws-1", {
        name: "Research",
        parent_id: "",
      }),
    );
  });

  it("disables creation inside package folders with a visible reason", async () => {
    renderPage("/acme/skills?folder=f-eng-fe");
    expect((await screen.findByRole("button", { name: "New folder" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Package folders follow the package.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for Frontend" })).toBeNull();
  });

  it("keeps custom and package-root menus, including package dialogs", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    expect(await screen.findByText("Rename")).toBeTruthy();
    expect(screen.getByText("Move")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(screen.queryByText("New subfolder")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Actions for Engineering" }));
    await userEvent.click(await screen.findByText("Rescan"));
    expect(await screen.findByTestId("rescan-dialog")).toBeTruthy();
  });

  it("explains that deleting a folder moves contents up without deleting skills", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Delete"));
    expect(
      await screen.findByText("Its skills and subfolders move up one level. No skills are deleted.", { exact: false }),
    ).toBeTruthy();
  });
});

describe("SkillsPage package candidates", () => {
  it("lists not-imported skills as disabled, non-navigating rows after imported skills", async () => {
    renderPage("/acme/skills?folder=f-eng-fe");
    const gray = await screen.findByText("gray-skill");
    const grayRow = gray.closest("[aria-disabled='true']");
    expect(grayRow).toBeTruthy();
    expect(screen.getByText("Not imported")).toBeTruthy();
    expect(gray.closest("[data-row-link]")).toBeNull();
    const placed = screen.getByText("placed-skill").closest("[role='row']");
    expect(placed).toBeTruthy();
    expect(placed!.compareDocumentPosition(grayRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("SkillsPage flat view and tree fallback", () => {
  it("searches every folder with path hints and returns to the original folder when cleared", async () => {
    const { controller } = renderPage("/acme/skills?view=compact&folder=f-eng");
    const search = await screen.findByRole("textbox", { name: "Search skills" });
    await userEvent.type(search, "skill");
    expect(await screen.findByText("Results from all folders")).toBeTruthy();
    expect(screen.getByText("Engineering / Frontend")).toBeTruthy();
    expect(screen.getByText("Design")).toBeTruthy();
    expect(screen.getByText("design-skill")).toBeTruthy();
    expect(screen.getByText("loose-skill").parentElement?.textContent).toBe("loose-skill");
    expect(screen.queryByRole("button", { name: "Open Design" })).toBeNull();
    expect(screen.queryByText("gray-skill")).toBeNull();
    expect(controller.path).toBe("/acme/skills?view=compact&folder=f-eng");

    await userEvent.clear(search);
    expect(await screen.findByText("engineering-skill")).toBeTruthy();
    expect(screen.queryByText("design-skill")).toBeNull();
    expect(controller.path).toBe("/acme/skills?view=compact&folder=f-eng");
  });

  it("uses flat view immediately when persisted filters are active", async () => {
    mocks.viewState.filters.origins = ["manual"];
    renderPage("/acme/skills?folder=f-eng");
    expect(await screen.findByText("Results from all folders")).toBeTruthy();
    expect(screen.getByText("design-skill")).toBeTruthy();
    expect(screen.getByText("Engineering / Frontend")).toBeTruthy();
  });

  it("keeps every skill visible with a retry when the tree cannot load", async () => {
    mocks.folderTree = null;
    mocks.folderTreeError = true;
    renderPage();
    expect(await screen.findByText("placed-skill")).toBeTruthy();
    expect(screen.getByText("engineering-skill")).toBeTruthy();
    expect(screen.getByText("design-skill")).toBeTruthy();
    expect(screen.getByText("loose-skill")).toBeTruthy();
    expect(screen.getByText("Folders are unavailable. Showing skills in a flat list.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetchTree).toHaveBeenCalled();
  });
});
