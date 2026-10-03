// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillPackage } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";

const apiMock = vi.hoisted(() => ({
  getSkillPackageDeletePreview: vi.fn(),
  dissolveSkillPackage: vi.fn(),
  deleteSkillPackage: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { PackageRemoveDialog } from "./package-remove-dialog";

const pkg: SkillPackage = {
  id: "p1",
  workspace_id: "ws-1",
  owner_repo: "o/r",
  subdirectory: "",
  source_url: "https://github.com/o/r/tree/main",
  ref: "main",
  root_folder_id: "f1",
  created_by: "u1",
  revision: 1,
  candidates: [{ path: "skills/a", name: "a", description: "" }],
};

const deletePreview = {
  preview_id: "token-1",
  skill_ids: ["s1", "s2"],
  affected_agents: [
    { id: "agent-1", name: "Writer", skill_id: "s1", skill_name: "alpha" },
    { id: "agent-1", name: "Writer", skill_id: "s2", skill_name: "beta" },
    { id: "agent-2", name: "Reviewer", skill_id: "s2", skill_name: "beta" },
  ],
  can_delete: true,
};

function renderDialog(mode: "dissolve" | "delete", onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <PackageRemoveDialog wsId="ws-1" pkg={pkg} mode={mode} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getSkillPackageDeletePreview.mockResolvedValue(deletePreview);
});

describe("PackageRemoveDialog impact preview", () => {
  it("lists every affected agent row before the delete confirm", async () => {
    renderDialog("delete");
    // One row per binding: Writer appears once for each of its two skills.
    expect(await screen.findAllByText("Writer")).toHaveLength(2);
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getAllByText(/· (alpha|beta)/)).toHaveLength(3);
    expect(
      screen.getByText(/2 packaged skills, their files, labels and agent bindings are permanently deleted/),
    ).toBeTruthy();
  });

  it("explains that dissolve keeps the skills", async () => {
    renderDialog("dissolve");
    expect(
      await screen.findByText(/2 skills stay as ordinary skills in their folders/),
    ).toBeTruthy();
  });

  it("shows the indeterminate state when the preview cannot be parsed", async () => {
    apiMock.getSkillPackageDeletePreview.mockResolvedValue(null);
    renderDialog("delete");
    expect(
      await screen.findByText("Couldn't load the impact preview. Try again."),
    ).toBeTruthy();
    expect(
      (await screen.findByRole("button", { name: "Delete package" })).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("PackageRemoveDialog permission gate", () => {
  it("blocks the confirm when the server reports insufficient permission", async () => {
    apiMock.getSkillPackageDeletePreview.mockResolvedValue({
      ...deletePreview,
      can_delete: false,
    });
    renderDialog("delete");
    expect(
      await screen.findByText("You don't have permission to remove every skill in this package."),
    ).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Delete package" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(apiMock.deleteSkillPackage).not.toHaveBeenCalled();
  });
});

describe("PackageRemoveDialog confirm and cancel", () => {
  it("deletes with the preview token and reports the outcome", async () => {
    apiMock.deleteSkillPackage.mockResolvedValue({ deleted: true, dissolved: false, skill_count: 2 });
    const onOpenChange = vi.fn();
    renderDialog("delete", onOpenChange);
    await userEvent.click(await screen.findByRole("button", { name: "Delete package" }));
    await waitFor(() =>
      expect(apiMock.deleteSkillPackage).toHaveBeenCalledWith("ws-1", "p1", "token-1"),
    );
    expect(toast.success).toHaveBeenCalledWith("Package and its skills deleted.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dissolves with the same token and keeps skills in the copy", async () => {
    apiMock.dissolveSkillPackage.mockResolvedValue({ deleted: false, dissolved: true, skill_count: 2 });
    renderDialog("dissolve");
    await userEvent.click(await screen.findByRole("button", { name: "Dissolve" }));
    await waitFor(() =>
      expect(apiMock.dissolveSkillPackage).toHaveBeenCalledWith("ws-1", "p1", "token-1"),
    );
    expect(toast.success).toHaveBeenCalledWith("Package dissolved; skills kept.");
  });

  it("cancel never touches the server", async () => {
    const onOpenChange = vi.fn();
    renderDialog("delete", onOpenChange);
    await screen.findAllByText("Writer");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(apiMock.deleteSkillPackage).not.toHaveBeenCalled();
    expect(apiMock.dissolveSkillPackage).not.toHaveBeenCalled();
  });
});
