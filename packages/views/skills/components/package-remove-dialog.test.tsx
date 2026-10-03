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
vi.mock("@multica/core/skills/package-queries", () => ({
  invalidateSkillPackageQueries: vi.fn(async () => {}),
}));

import { toast } from "sonner";
import { invalidateSkillPackageQueries } from "@multica/core/skills/package-queries";
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
  it("blocks only deletion when the server reports insufficient permission", async () => {
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

  it("still allows dissolve: it needs package permission, not per-skill permission", async () => {
    apiMock.getSkillPackageDeletePreview.mockResolvedValue({
      ...deletePreview,
      can_delete: false,
    });
    apiMock.dissolveSkillPackage.mockResolvedValue({ deleted: false, dissolved: true, skill_count: 2 });
    renderDialog("dissolve");
    // The per-skill warning is not even shown in dissolve mode.
    await screen.findAllByText("Writer");
    expect(
      screen.queryByText("You don't have permission to remove every skill in this package."),
    ).toBeNull();
    const confirm = screen.getByRole("button", { name: "Dissolve" });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(apiMock.dissolveSkillPackage).toHaveBeenCalledWith("ws-1", "p1", "token-1"),
    );
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

describe("PackageRemoveDialog indeterminate results", () => {
  it("treats an unreadable result as unconfirmed, never as a clean failure", async () => {
    apiMock.deleteSkillPackage.mockResolvedValue(null);
    renderDialog("delete");
    await userEvent.click(await screen.findByRole("button", { name: "Delete package" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).toContain("couldn't be confirmed");
    expect(message).not.toMatch(/operation failed/i);
    // The projections refresh on settle even when the outcome is unknown.
    expect(invalidateSkillPackageQueries).toHaveBeenCalled();
  });

  it("discards the spent token and reloads the impact preview after a failed write", async () => {
    apiMock.getSkillPackageDeletePreview
      .mockResolvedValueOnce(deletePreview)
      .mockResolvedValueOnce({ ...deletePreview, preview_id: "token-2" });
    apiMock.deleteSkillPackage
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ deleted: true, dissolved: false, skill_count: 2 });

    renderDialog("delete");
    await userEvent.click(await screen.findByRole("button", { name: "Delete package" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    // The dialog reloads the preview itself; the retry confirms against
    // the fresh token, never the spent one.
    await waitFor(() =>
      expect(apiMock.getSkillPackageDeletePreview).toHaveBeenCalledTimes(2),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Delete package" }));
    await waitFor(() =>
      expect(apiMock.deleteSkillPackage).toHaveBeenCalledTimes(2),
    );
    expect(apiMock.deleteSkillPackage).toHaveBeenNthCalledWith(1, "ws-1", "p1", "token-1");
    expect(apiMock.deleteSkillPackage).toHaveBeenNthCalledWith(2, "ws-1", "p1", "token-2");
    expect(toast.success).toHaveBeenCalledWith("Package and its skills deleted.");
  });

  it("refreshes queries after a network-error settle as well", async () => {
    apiMock.dissolveSkillPackage.mockRejectedValue(new Error("offline"));
    renderDialog("dissolve");
    await userEvent.click(await screen.findByRole("button", { name: "Dissolve" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(invalidateSkillPackageQueries).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      { includeSkills: true },
    );
  });
});
