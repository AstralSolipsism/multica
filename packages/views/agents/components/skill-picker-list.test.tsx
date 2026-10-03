// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";

const mocks = vi.hoisted(() => ({
  wsId: "ws-1",
  trees: new Map<string, SkillFolderTree>(),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => mocks.wsId,
}));

vi.mock("@multica/core/skills/package-queries", () => ({
  skillFolderTreeOptions: (wsId: string) => ({
    queryKey: ["workspaces", wsId, "skill-folders"],
    queryFn: async () => mocks.trees.get(wsId) ?? null,
  }),
}));

import { SkillPickerList } from "./skill-picker-list";

function skill(id: string, name = id, description = ""): SkillSummary {
  return {
    id,
    workspace_id: "ws-1",
    name,
    description,
    config: {},
    created_by: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function folder(id: string, name: string, parentId: string | null = null) {
  return {
    id,
    workspace_id: "ws-1",
    parent_id: parentId,
    name,
    package_id: null,
    package_path: null,
    created_at: "",
    updated_at: "",
  };
}

const treeA: SkillFolderTree = {
  folders: [
    folder("f-eng", "Engineering"),
    folder("f-eng-fe", "Frontend", "f-eng"),
  ],
  placements: [
    { workspace_id: "ws-1", skill_id: "a", folder_id: "f-eng-fe", package_id: null, source_path: null },
    { workspace_id: "ws-1", skill_id: "b", folder_id: "f-eng-fe", package_id: null, source_path: null },
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
      created_by: "u1",
      revision: 1,
      candidates: [{ path: "skills/gray", name: "gray-skill", description: "" }],
    },
  ],
};

const treeB: SkillFolderTree = {
  folders: [folder("f-other", "OtherWS")],
  placements: [
    { workspace_id: "ws-2", skill_id: "a", folder_id: "f-other", package_id: null, source_path: null },
  ],
  packages: [],
};

function renderPicker(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wsId = "ws-1";
  mocks.trees = new Map([
    ["ws-1", treeA],
    ["ws-2", treeB],
  ]);
});

describe("SkillPickerList flat mode (regression)", () => {
  const skills = [skill("a", "alpha", "first"), skill("b", "beta")];

  it("toggles rows and filters by search without any tree", async () => {
    const onToggle = vi.fn();
    renderPicker(
      <SkillPickerList skills={skills} selectedIds={new Set()} onToggle={onToggle} />,
    );
    await userEvent.click(screen.getByText("alpha"));
    expect(onToggle).toHaveBeenCalledWith(skills[0]);

    await userEvent.type(
      screen.getByPlaceholderText("Search skills…"),
      "first",
    );
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.getByText("alpha")).toBeTruthy();
  });
});

describe("SkillPickerList tree mode", () => {
  const skills = [skill("a", "alpha"), skill("b", "beta"), skill("c", "gamma")];

  it("groups skills under folders with tri-state folder checks", async () => {
    const toggled: string[][] = [];
    renderPicker(
      <SkillPickerList
        tree
        skills={skills}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onToggleMany={(list) => toggled.push(list.map((s) => s.id))}
      />,
    );
    // Skills a+b sit under Engineering/Frontend; c is uncategorized.
    expect(await screen.findByText("Engineering")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("Uncategorized")).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select all in Engineering" }),
    );
    expect(toggled).toHaveLength(1);
    expect(toggled[0]?.slice().sort()).toEqual(["a", "b"]);
  });

  it("reflects partial selection as a mixed folder checkbox", async () => {
    renderPicker(
      <SkillPickerList
        tree
        skills={skills}
        selectedIds={new Set(["a"])}
        onToggle={vi.fn()}
        onToggleMany={vi.fn()}
      />,
    );
    const box = await screen.findByRole("checkbox", { name: "Select all in Engineering" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
  });

  it("prunes folders whose skills the caller filtered out (attached items)", async () => {
    // Caller passes only "c": a/b disappear, and "Frontend" — holding only
    // those filtered skills — goes with them. "Engineering" survives on its
    // gray (not-yet-imported) candidate, never on attached skills.
    renderPicker(
      <SkillPickerList
        tree
        skills={[skills[2]!]}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onToggleMany={vi.fn()}
      />,
    );
    await screen.findByText("gamma");
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.queryByText("Frontend")).toBeNull();
    // "Engineering" survives on its gray candidate, collapsed by default
    // (no selectable skills inside); expanding reveals the gray row.
    expect(screen.queryByText("gray-skill")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Expand Engineering" }),
    );
    expect(await screen.findByText("gray-skill")).toBeTruthy();
  });

  it("shows not-imported candidates as gray rows that cannot be toggled", async () => {
    const onToggle = vi.fn();
    const onToggleMany = vi.fn();
    renderPicker(
      <SkillPickerList
        tree
        skills={skills}
        selectedIds={new Set()}
        onToggle={onToggle}
        onToggleMany={onToggleMany}
      />,
    );
    const gray = await screen.findByText("gray-skill");
    expect(gray.closest("[aria-disabled]")).toBeTruthy();
    // The folder tri-state never includes gray candidates.
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select all in Engineering" }),
    );
    expect(onToggleMany).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ name: "gray-skill" })]),
      true,
    );
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("flattens search results with folder paths", async () => {
    renderPicker(
      <SkillPickerList
        tree
        skills={skills}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onToggleMany={vi.fn()}
      />,
    );
    await userEvent.type(await screen.findByPlaceholderText("Search skills…"), "alpha");
    expect(await screen.findByText("Engineering / Frontend")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
    // Gray candidates surface in search too, still disabled.
    await userEvent.clear(screen.getByPlaceholderText("Search skills…"));
    await userEvent.type(screen.getByPlaceholderText("Search skills…"), "gray");
    expect(await screen.findByText("gray-skill")).toBeTruthy();
  });

  it("rebinds the tree when the workspace changes", async () => {
    const { rerender } = renderPicker(
      <SkillPickerList
        tree
        skills={skills}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onToggleMany={vi.fn()}
      />,
    );
    expect(await screen.findByText("Engineering")).toBeTruthy();

    mocks.wsId = "ws-2";
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SkillPickerList
          tree
          skills={skills}
          selectedIds={new Set()}
          onToggle={vi.fn()}
          onToggleMany={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText("Engineering")).toBeNull());
    expect(await screen.findByText("OtherWS")).toBeTruthy();
  });

  it("falls back to the flat list with a notice when the tree is unreadable", async () => {
    mocks.trees = new Map([["ws-1", null as never]]);
    renderPicker(
      <SkillPickerList
        tree
        skills={skills}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onToggleMany={vi.fn()}
      />,
    );
    expect(await screen.findByText("Folders couldn't be loaded.")).toBeTruthy();
    // Binding still works without the tree.
    expect(screen.getByText("alpha")).toBeTruthy();
  });
});
