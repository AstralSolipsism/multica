// @vitest-environment jsdom

import React, { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportedLocale } from "@multica/core/i18n";
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
  folderTreeFailures: 0,
  refetchTree: vi.fn(),
  currentUserId: "user-1",
  members: [] as { user_id: string; role: string }[],
  virtualizerCount: 0,
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
        failureCount: mocks.folderTreeFailures,
        refetch: mocks.refetchTree,
      };
    }
    if (key[0] === "members") {
      return { data: mocks.members, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: [], isLoading: false, error: null, refetch: vi.fn() };
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
          start: index * 48,
          end: (index + 1) * 48,
          size: 48,
        })),
      getTotalSize: () => count * 48,
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
vi.mock("@multica/ui/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => (
    <div data-testid="skeleton" {...props} />
  ),
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
  SkillBatchToolbar: ({ rows }: { rows: { skill: { id: string } }[] }) => (
    <div data-testid="batch-selection">{rows.map((row) => row.skill.id).join(",")}</div>
  ),
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

function renderPage(initialPath = "/acme/skills", locale?: SupportedLocale) {
  const controller = makeController(initialPath);
  const ui = (
    <NavigationHarness controller={controller} initialPath={initialPath}>
      <SkillsPage />
    </NavigationHarness>
  );
  const result = renderWithI18n(ui, { locale });
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
  mocks.folderTreeFailures = 0;
  mocks.refetchTree = vi.fn();
  mocks.currentUserId = "user-1";
  mocks.members = [];
  mocks.virtualizerCount = 0;
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

describe("SkillsPage review regressions", () => {
  it("localizes the root breadcrumb with the page title", async () => {
    renderPage("/acme/skills", "ja");
    expect(await screen.findByRole("button", { name: "スキル" })).toBeTruthy();
  });

  it("shows a skeleton instead of flashing the flat list while the tree loads", () => {
    mocks.folderTree = undefined;
    renderPage("/acme/skills?folder=f-eng-fe");
    // Positive assertions (N2): the loading skeleton is what renders, never
    // a premature empty-folder or flat view.
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("placed-skill")).toBeNull();
    expect(screen.queryByText("This folder is empty.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Engineering" })).toBeNull();
    expect(screen.queryByText("Results from all folders")).toBeNull();
  });

  it("keeps the upstream empty-workspace state", async () => {
    mocks.skills = [];
    mocks.folderTree = { folders: [], placements: [], packages: [] };
    renderPage();
    expect(await screen.findByText("No skills yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New skill" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("No skills or folders yet.")).toBeNull();
  });

  it("moves Up from a nested folder to its direct parent", async () => {
    const { controller } = renderPage("/acme/skills?folder=f-eng-fe");
    await userEvent.click(await screen.findByRole("button", { name: "Up one level" }));
    expect(controller.path).toBe("/acme/skills?folder=f-eng");
    expect(await screen.findByText("engineering-skill")).toBeTruthy();
  });

  it("disables all package actions for a non-importer without admin rights", async () => {
    mocks.currentUserId = "someone-else";
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Engineering" }));
    expect(
      await screen.findByText("Only the package importer or an admin can do this."),
    ).toBeTruthy();
    for (const name of ["Rescan", "Rename", "Move", "Dissolve package", "Delete package"]) {
      expect(screen.getByText(name).closest("[data-disabled]")).toBeTruthy();
    }
  });

  it("enables package actions for an admin who did not import the package", async () => {
    mocks.currentUserId = "someone-else";
    mocks.members = [{ user_id: "someone-else", role: "admin" }];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Engineering" }));
    expect(await screen.findByText("Rescan")).toBeTruthy();
    expect(screen.queryByText("Only the package importer or an admin can do this.")).toBeNull();
    for (const name of ["Rescan", "Rename", "Move", "Dissolve package", "Delete package"]) {
      expect(screen.getByText(name).closest("[data-disabled]")).toBeNull();
    }
  });

  it("opens dissolve and delete dialogs from their distinct package actions", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Engineering" }));
    await userEvent.click(await screen.findByText("Dissolve package"));
    expect(await screen.findByTestId("remove-dialog-dissolve")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Engineering" }));
    await userEvent.click(await screen.findByText("Delete package"));
    expect(await screen.findByTestId("remove-dialog-delete")).toBeTruthy();
  });

  it("limits selection and select-all to skill rows in the current folder view", async () => {
    renderPage("/acme/skills?folder=f-design");
    const designRow = (await screen.findByText("design-skill")).closest("[role='row']")!;
    await userEvent.click(designRow.querySelector("button")!);
    expect(screen.getByTestId("batch-selection").textContent).toBe("design");

    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByTestId("batch-selection").textContent).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Open Design" }));
    expect(screen.getByTestId("batch-selection").textContent).toBe("design");

    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    const header = screen.getAllByRole("row")[0]!;
    await userEvent.click(within(header).getAllByRole("button")[0]!);
    expect(screen.getByTestId("batch-selection").textContent).toBe("loose");
  });

  it("keeps folder rows before skills with package badges, subtree counts and exact virtual counts", async () => {
    renderPage();
    const packageButton = await screen.findByRole("button", { name: "Open Engineering" });
    expect(packageButton.textContent).toContain("Package");
    expect(packageButton.textContent).toContain("2 skills");

    await userEvent.click(packageButton);
    expect(mocks.virtualizerCount).toBe(2);
    const folderRow = (await screen.findByRole("button", { name: "Open Frontend" })).closest("[role='row']")!;
    const skillRow = screen.getByText("engineering-skill").closest("[role='row']")!;
    expect(folderRow.compareDocumentPosition(skillRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("SkillsPage unreadable write responses", () => {
  it("refreshes the tree and shows an indeterminate result when a folder create reads back null", async () => {
    const { invalidateSkillPackageQueries } = await import(
      "@multica/core/skills/package-queries"
    );
    apiMock.createSkillFolder.mockResolvedValue(null);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Ghost");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText(
        "The result couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    ).toBeTruthy();
    expect(invalidateSkillPackageQueries).toHaveBeenCalled();
    expect(screen.queryByText("Couldn't save the folder. Try again.")).toBeNull();
  });

  it("refreshes the tree and shows an indeterminate result when a folder move reads back null", async () => {
    const { invalidateSkillPackageQueries } = await import(
      "@multica/core/skills/package-queries"
    );
    apiMock.updateSkillFolder.mockResolvedValue(null);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Move"));
    await userEvent.click(await screen.findByRole("button", { name: "Empty" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.updateSkillFolder).toHaveBeenCalledWith("ws-1", "f-design", { parent_id: "f-empty" }),
    );
    expect(
      await screen.findByText(
        "The result couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    ).toBeTruthy();
    expect(invalidateSkillPackageQueries).toHaveBeenCalled();
    expect(screen.queryByText("Couldn't move the folder. Try again.")).toBeNull();
  });

  it("refreshes the tree and shows an indeterminate result when a folder delete reads back null", async () => {
    const { invalidateSkillPackageQueries } = await import(
      "@multica/core/skills/package-queries"
    );
    apiMock.deleteSkillFolder.mockResolvedValue(null);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Delete"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiMock.deleteSkillFolder).toHaveBeenCalledWith("ws-1", "f-design"),
    );
    expect(
      await screen.findByText(
        "The result couldn't be confirmed. The list was refreshed — check it before retrying.",
      ),
    ).toBeTruthy();
    expect(invalidateSkillPackageQueries).toHaveBeenCalled();
    expect(screen.queryByText("Couldn't delete the folder. Try again.")).toBeNull();
  });
});

describe("SkillsPage localized folder errors", () => {
  it("localizes a coded create error instead of showing the server message", async () => {
    const { ApiError } = await import("@multica/core/api");
    apiMock.createSkillFolder.mockRejectedValue(
      new ApiError("a folder with this name already exists at the destination", 409, "Conflict", {
        code: "name_conflict",
        error: "a folder with this name already exists at the destination",
      }),
    );
    renderPage("/acme/skills", "zh-Hans");
    await userEvent.click(await screen.findByRole("button", { name: "新建文件夹" }));
    await userEvent.type(screen.getByLabelText("名称"), "Research");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("目标位置已存在同名文件夹，请换一个名称。")).toBeTruthy();
    expect(screen.queryByText(/already exists at the destination/)).toBeNull();
  });

  it("localizes a coded move error", async () => {
    const { ApiError } = await import("@multica/core/api");
    apiMock.updateSkillFolder.mockRejectedValue(
      new ApiError("folder move would create a cycle", 409, "Conflict", {
        code: "folder_cycle",
        error: "folder move would create a cycle",
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Design" }));
    await userEvent.click(await screen.findByText("Move"));
    await userEvent.click(await screen.findByRole("button", { name: "Empty" }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(
      await screen.findByText("A folder can't be moved into one of its own subfolders."),
    ).toBeTruthy();
    expect(screen.queryByText("folder move would create a cycle")).toBeNull();
  });

  it("localizes a coded delete error", async () => {
    const { ApiError } = await import("@multica/core/api");
    apiMock.deleteSkillFolder.mockRejectedValue(
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
    apiMock.createSkillFolder.mockRejectedValue(new Error("socket hangup"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(screen.getByLabelText("Name"), "Ghost");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Couldn't save the folder. Try again.")).toBeTruthy();
    expect(screen.queryByText("socket hangup")).toBeNull();
  });
});

describe("SkillsPage tree wait fallback", () => {
  it("falls back to the flat list on the first failed tree attempt, before the retry settles", () => {
    mocks.folderTree = undefined;
    mocks.folderTreeFailures = 1;
    renderPage();
    expect(screen.getByText("placed-skill")).toBeTruthy();
    expect(screen.getByText("engineering-skill")).toBeTruthy();
    expect(screen.getByText("design-skill")).toBeTruthy();
    expect(screen.getByText("loose-skill")).toBeTruthy();
    expect(
      screen.getByText("Folders are unavailable. Showing skills in a flat list."),
    ).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Engineering" })).toBeNull();
  });

  it("falls back to the flat list after 5s without tree data, then restores the hierarchy when it arrives", async () => {
    vi.useFakeTimers();
    try {
      mocks.folderTree = undefined;
      const { controller, rerender } = renderPage("/acme/skills?folder=f-eng-fe");
      // Inside the grace window the skeleton shows; nothing flat flashes.
      expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
      expect(screen.queryByText("placed-skill")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText("placed-skill")).toBeTruthy();
      expect(screen.getByText("loose-skill")).toBeTruthy();
      expect(
        screen.getByText("Folders are unavailable. Showing skills in a flat list."),
      ).toBeTruthy();

      // Late data restores the hierarchy at the requested folder.
      mocks.folderTree = folderTree;
      rerender(
        <NavigationHarness controller={controller} initialPath="/acme/skills?folder=f-eng-fe">
          <SkillsPage />
        </NavigationHarness>,
      );
      expect(screen.queryByText("Folders are unavailable. Showing skills in a flat list.")).toBeNull();
      expect(screen.getByText("placed-skill")).toBeTruthy();
      expect(screen.queryByText("engineering-skill")).toBeNull();
      expect(screen.queryByText("loose-skill")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SkillsPage folder rows without skills", () => {
  it("keeps folder rows when folders exist but the workspace has 0 skills (N3)", async () => {
    mocks.skills = [];
    renderPage();
    expect(await screen.findByRole("button", { name: "Open Engineering" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Design" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Empty" })).toBeTruthy();
    // The upstream empty-workspace state stays hidden while folders exist.
    expect(screen.queryByText("No skills yet")).toBeNull();
    expect(screen.getByText("0 here / 0 in workspace")).toBeTruthy();
  });
});

describe("SkillsPage select-all scope", () => {
  it("selects only the current folder view, never skills outside it (M05)", async () => {
    renderPage("/acme/skills?folder=f-design");
    const header = screen.getAllByRole("row")[0]!;
    await userEvent.click(within(header).getAllByRole("button")[0]!);
    expect(screen.getByTestId("batch-selection").textContent).toBe("design");

    // Back at the root, the folder-view select-all must not have swept up
    // root skills: nothing selected there.
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByTestId("batch-selection").textContent).toBe("");
  });
});
