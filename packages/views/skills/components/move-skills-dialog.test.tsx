// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";
import type { SkillRow } from "./skill-list-filter";

const apiMock = vi.hoisted(() => ({
  setSkillPlacement: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { MoveSkillsDialog } from "./move-skills-dialog";

const tree: SkillFolderTree = {
  folders: [
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
    {
      id: "pkg-root",
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
      parent_id: "pkg-root",
      name: "deep",
      package_id: "p1",
      package_path: "deep",
      created_at: "",
      updated_at: "",
    },
  ],
  placements: [],
  packages: [],
};

function makeRow(id: string, canEdit = true): SkillRow {
  const skill: SkillSummary = {
    id,
    workspace_id: "ws-1",
    name: id,
    description: "",
    config: {},
    created_by: "u1",
    created_at: "",
    updated_at: "",
  };
  return { skill, agents: [], creator: null, runtime: null, originType: "manual", canEdit };
}

function renderDialog(rows: SkillRow[], onMoved = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onMoved,
    ...renderWithI18n(
      <QueryClientProvider client={qc}>
        <MoveSkillsDialog wsId="ws-1" tree={tree} rows={rows} open onOpenChange={vi.fn()} onMoved={onMoved} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.setSkillPlacement.mockResolvedValue({ updated: true });
});

describe("MoveSkillsDialog", () => {
  it("offers custom folders only — every package folder is refused server-side", async () => {
    renderDialog([makeRow("s1")]);
    expect(await screen.findByText("Custom")).toBeTruthy();
    expect(screen.getByText("Uncategorized")).toBeTruthy();
    // Package roots and managed internals are not destinations (409
    // managed_folder), so they never appear.
    expect(screen.queryByText("o/r")).toBeNull();
    expect(screen.queryByText("deep")).toBeNull();
  });

  it("moves every row to the chosen folder", async () => {
    const { onMoved } = renderDialog([makeRow("s1"), makeRow("s2")]);
    await userEvent.click(await screen.findByText("Custom"));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(apiMock.setSkillPlacement).toHaveBeenCalledTimes(2));
    expect(apiMock.setSkillPlacement).toHaveBeenCalledWith("ws-1", "s1", "custom");
    expect(apiMock.setSkillPlacement).toHaveBeenCalledWith("ws-1", "s2", "custom");
    expect(toast.success).toHaveBeenCalledWith("2 skills moved.");
    expect(onMoved).toHaveBeenCalled();
  });

  it("clears the placement when Uncategorized is chosen", async () => {
    renderDialog([makeRow("s1")]);
    await userEvent.click(await screen.findByText("Uncategorized"));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(apiMock.setSkillPlacement).toHaveBeenCalledWith("ws-1", "s1", ""),
    );
  });

  it("reports partial failure without claiming full success", async () => {
    apiMock.setSkillPlacement
      .mockResolvedValueOnce({ updated: true })
      .mockRejectedValueOnce(new Error("nope"));
    const { onMoved } = renderDialog([makeRow("s1"), makeRow("s2")]);
    await userEvent.click(await screen.findByText("Custom"));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(apiMock.setSkillPlacement).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledWith("Moved 1 of 2; the rest failed.");
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("treats an unreadable placement result as a failure", async () => {
    apiMock.setSkillPlacement.mockResolvedValue(null);
    const { onMoved } = renderDialog([makeRow("s1")]);
    await userEvent.click(await screen.findByText("Custom"));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(apiMock.setSkillPlacement).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith("Couldn't move the skills. Try again.");
    expect(onMoved).not.toHaveBeenCalled();
  });
});
