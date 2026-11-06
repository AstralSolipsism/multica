// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderExplorerBreadcrumbs } from "./folder-explorer-breadcrumbs";
import { FolderExplorerNameCell } from "./folder-explorer-row";
import { FolderExplorerHeaderActions } from "./folder-explorer-header-actions";
import { NewFolderButton } from "./new-folder-button";

describe("folder explorer components", () => {
  it("navigates from every breadcrumb, including the root", async () => {
    const onNavigate = vi.fn();
    render(
      <FolderExplorerBreadcrumbs
        ariaLabel="Folder location"
        rootLabel="Skills"
        path={[
          { id: "a", name: "Alpha", parentId: null, managed: false },
          { id: "b", name: "Beta", parentId: "a", managed: false },
        ]}
        onNavigate={onNavigate}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(onNavigate).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onNavigate).toHaveBeenLastCalledWith("a");
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens a folder from its keyboard-accessible CollectionList name cell", async () => {
    const onOpen = vi.fn();
    render(
      <FolderExplorerNameCell
        name="Engineering"
        typeLabel="Package"
        countLabel="3 skills"
        openLabel="Open Engineering"
        onOpen={onOpen}
      />,
    );
    const button = screen.getByRole("button", { name: "Open Engineering" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText("3 skills"));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(button.querySelector(".whitespace-nowrap")).toBeTruthy();
  });

  it("exposes expansion state and renders 20px depth guides", () => {
    render(
      <FolderExplorerNameCell
        name="Nested"
        countLabel="1 skill"
        openLabel="Collapse Nested"
        onOpen={vi.fn()}
        expanded
        depth={2}
      />,
    );
    const button = screen.getByRole("button", { name: "Collapse Nested" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("rotate-90");
    expect(button.parentElement?.querySelectorAll(".bg-border")).toHaveLength(2);
    expect(button.parentElement?.querySelector('[style*="width: 40px"]')).not.toBeNull();
  });

  it("keeps expand, collapse, and new-folder actions in the collection header", async () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    const onNewFolder = vi.fn();
    render(
      <FolderExplorerHeaderActions
        hasFolders
        expandAllLabel="Expand all"
        collapseAllLabel="Collapse all"
        newFolderLabel="New folder"
        onExpandAll={onExpandAll}
        onCollapseAll={onCollapseAll}
        onNewFolder={onNewFolder}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("keeps the managed-folder reason visible beside the disabled action", () => {
    render(
      <NewFolderButton
        label="New folder"
        disabled
        disabledReason="Package folders follow the package."
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New folder" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Package folders follow the package.")).toBeTruthy();
  });
});
