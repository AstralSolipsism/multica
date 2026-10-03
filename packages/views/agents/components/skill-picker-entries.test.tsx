// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Agent, SkillSummary } from "@multica/core/types";
import type { SkillFolderTree } from "@multica/core/api/schemas";
import { renderWithI18n } from "../../test/i18n";

// Wiring proof for the OL-104 tree picker's two entries: the folder
// tri-state must reach each caller's selection (and, for the dialog, the
// bind request), not just render inside SkillPickerList.

const apiMock = vi.hoisted(() => ({
  listSkills: vi.fn(async (): Promise<SkillSummary[]> => []),
  setAgentSkills: vi.fn(async (_agentId: string, _body: { skill_ids: string[] }) => {}),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

const folderTree: SkillFolderTree = {
  folders: [
    {
      id: "f-eng",
      workspace_id: "ws-1",
      parent_id: null,
      name: "Engineering",
      package_id: null,
      package_path: null,
      created_at: "",
      updated_at: "",
    },
  ],
  placements: [
    { workspace_id: "ws-1", skill_id: "free-1", folder_id: "f-eng", package_id: null, source_path: null },
    { workspace_id: "ws-1", skill_id: "free-2", folder_id: "f-eng", package_id: null, source_path: null },
  ],
  packages: [],
};

vi.mock("@multica/core/skills/package-queries", () => ({
  skillFolderTreeOptions: (wsId: string) => ({
    queryKey: ["workspaces", wsId, "skill-folders"],
    queryFn: async () => folderTree,
  }),
}));

import { SkillAddDialog } from "./skill-add-dialog";
import { SkillMultiSelect } from "./skill-multi-select";

function skill(id: string): SkillSummary {
  return {
    id,
    workspace_id: "ws-1",
    name: id,
    description: "",
    config: {},
    created_by: "u1",
    created_at: "",
    updated_at: "",
  };
}

const workspaceSkills = [skill("attached-1"), skill("free-1"), skill("free-2")];

const agent = {
  id: "agent-1",
  name: "Writer",
  skills: [{ id: "attached-1", name: "attached-1" }],
} as unknown as Agent;

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listSkills.mockResolvedValue(workspaceSkills);
});

describe("SkillAddDialog tree wiring", () => {
  it("folder tri-state selects only unattached skills and the confirm binds them", async () => {
    renderWithClient(<SkillAddDialog agent={agent} open onOpenChange={vi.fn()} />);

    // The attached skill never renders; the folder groups the two free ones.
    expect(await screen.findByText("Engineering")).toBeTruthy();
    expect(screen.queryByText("attached-1")).toBeNull();

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select all in Engineering" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Add 2/ }));

    // Existing binding protocol unchanged: full-replace set with the
    // previously attached id preserved.
    await vi.waitFor(() =>
      expect(apiMock.setAgentSkills).toHaveBeenCalledWith("agent-1", {
        skill_ids: expect.arrayContaining(["attached-1", "free-1", "free-2"]),
      }),
    );
    const body = apiMock.setAgentSkills.mock.calls[0]?.[1] as { skill_ids: string[] };
    expect(body.skill_ids).toHaveLength(3);
  });
});

describe("SkillMultiSelect tree wiring", () => {
  it("folder tri-state reports the whole subtree through onChange", async () => {
    const onChange = vi.fn();
    renderWithClient(<SkillMultiSelect selectedIds={new Set()} onChange={onChange} />);

    // Collapsed by default: expand the section first.
    await userEvent.click(await screen.findByText("Add skills from workspace"));
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select all in Engineering" }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...(onChange.mock.calls[0]?.[0] as Set<string>)].sort()).toEqual(["free-1", "free-2"]);
  });
});
