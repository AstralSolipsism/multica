// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";
import type { FolderSelection } from "../lib/skill-folder-tree";

vi.mock("@multica/core/api", () => ({
  api: {
    createSkillFolder: vi.fn(),
    updateSkillFolder: vi.fn(),
    deleteSkillFolder: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Dialogs are verified in their own suites; here they only prove the menu opens them.
vi.mock("./package-rescan-dialog", () => ({
  RescanPackageDialog: () => <div data-testid="rescan-dialog" />,
}));
vi.mock("./package-remove-dialog", () => ({
  PackageRemoveDialog: ({ mode }: { mode: string }) => (
    <div data-testid={`remove-dialog-${mode}`} />
  ),
}));

import { SkillFolderTreePanel } from "./skill-folder-tree-panel";

const tree: SkillFolderTree = {
  folders: [
    {
      id: "root-pkg",
      workspace_id: "ws-1",
      parent_id: null,
      name: "o/r",
      package_id: "p1",
      package_path: "",
      created_at: "",
      updated_at: "",
    },
    {
      id: "managed",
      workspace_id: "ws-1",
      parent_id: "root-pkg",
      name: "deep",
      package_id: "p1",
      package_path: "deep",
      created_at: "",
      updated_at: "",
    },
    {
      id: "custom",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Custom",
      package_id: null,
      package_path: null,
      created_at: "",
      updated_at: "",
    },
  ],
  placements: [
    { workspace_id: "ws-1", skill_id: "s1", folder_id: "root-pkg", package_id: "p1", source_path: "skills/s1" },
  ],
  packages: [
    {
      id: "p1",
      workspace_id: "ws-1",
      owner_repo: "o/r",
      subdirectory: "",
      source_url: "https://github.com/o/r/tree/main",
      ref: "main",
      root_folder_id: "root-pkg",
      created_by: "importer-1",
      revision: 1,
      candidates: [
        { path: "skills/s1", name: "s1", description: "" },
        { path: "skills/deep/gray", name: "gray-one", description: "" },
      ],
    },
  ],
};

function renderPanel({
  selection = { kind: "all" } as FolderSelection,
  onSelect = vi.fn(),
  currentUserId = "importer-1",
  isAdmin = false,
  treeData = tree as SkillFolderTree | null | undefined,
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <SkillFolderTreePanel
        wsId="ws-1"
        tree={treeData}
        treeError={false}
        onRetryTree={vi.fn()}
        selection={selection}
        onSelect={onSelect}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
      />
    </QueryClientProvider>
  );
  return renderWithI18n(ui as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SkillFolderTreePanel selection rows", () => {
  it("offers All and Uncategorized above the folders", async () => {
    const onSelect = vi.fn();
    renderPanel({ onSelect });
    await userEvent.click(screen.getByText("All skills"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "all" });
    await userEvent.click(screen.getByText("Uncategorized"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "uncategorized" });
  });

  it("selects a folder to filter its subtree", async () => {
    const onSelect = vi.fn();
    renderPanel({ onSelect });
    await userEvent.click(screen.getByText("Custom"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "folder", folderId: "custom" });
  });

  it("marks the selected folder row pressed", () => {
    renderPanel({ selection: { kind: "folder", folderId: "custom" } });
    const row = screen.getByText("Custom").closest("button");
    expect(row?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("SkillFolderTreePanel gray candidates", () => {
  it("lists not-imported candidates as disabled rows under their managed folder", () => {
    renderPanel();
    const gray = screen.getByText("gray-one");
    expect(gray.closest("[aria-disabled]")).toBeTruthy();
    expect(screen.getByText("Not imported")).toBeTruthy();
  });
});

describe("SkillFolderTreePanel folder menus", () => {
  it("gives custom folders create/rename/move/delete actions", async () => {
    renderPanel();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Custom" }),
    );
    expect(await screen.findByText("New subfolder")).toBeTruthy();
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Move")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("gives managed internal folders no action menu", () => {
    renderPanel();
    expect(
      screen.queryByRole("button", { name: "Actions for deep" }),
    ).toBeNull();
  });

  it("opens the rescan dialog from a permitted package root menu", async () => {
    renderPanel({ currentUserId: "importer-1" });
    await userEvent.click(screen.getByRole("button", { name: "Actions for o/r" }));
    await userEvent.click(await screen.findByText("Rescan"));
    expect(await screen.findByTestId("rescan-dialog")).toBeTruthy();
  });

  it("opens the dissolve and delete dialogs from the package root menu", async () => {
    renderPanel({ currentUserId: "importer-1" });
    await userEvent.click(screen.getByRole("button", { name: "Actions for o/r" }));
    await userEvent.click(await screen.findByText("Dissolve package"));
    expect(await screen.findByTestId("remove-dialog-dissolve")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Actions for o/r" }));
    await userEvent.click(await screen.findByText("Delete package"));
    expect(await screen.findByTestId("remove-dialog-delete")).toBeTruthy();
  });

  it("disables package actions for members who are neither importer nor admin", async () => {
    renderPanel({ currentUserId: "someone-else", isAdmin: false });
    await userEvent.click(screen.getByRole("button", { name: "Actions for o/r" }));
    const rescan = await screen.findByText("Rescan");
    expect(
      screen.getByText("Only the package importer or an admin can do this."),
    ).toBeTruthy();
    expect(rescan.closest("[data-disabled]")).toBeTruthy();
    expect(screen.queryByTestId("rescan-dialog")).toBeNull();
  });

  it("keeps package actions enabled for an admin who did not import", async () => {
    renderPanel({ currentUserId: "someone-else", isAdmin: true });
    await userEvent.click(screen.getByRole("button", { name: "Actions for o/r" }));
    const rescan = await screen.findByText("Rescan");
    expect(rescan.closest("[data-disabled]")).toBeNull();
  });
});

describe("SkillFolderTreePanel tree states", () => {
  it("shows the indeterminate state with retry when the tree is unreadable", async () => {
    const onRetry = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithI18n(
      <QueryClientProvider client={qc}>
        <SkillFolderTreePanel
          wsId="ws-1"
          tree={null}
          treeError={false}
          onRetryTree={onRetry}
          selection={{ kind: "all" }}
          onSelect={vi.fn()}
          currentUserId="u"
          isAdmin={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Folders couldn't be loaded.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});
