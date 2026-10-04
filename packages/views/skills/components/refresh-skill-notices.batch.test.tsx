// @vitest-environment jsdom

// Labrastro fork tests for refresh-skill-notices.tsx (batch update). Moved
// from skill-list-actions.test.tsx in OL-107: harness copied, assertions
// unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillSummary } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";
import enSkillPackages from "../../locales/en/skill-packages.json";
import type { SkillRow } from "./skill-list-filter";
import type { SkillActionsContext } from "./skill-list-actions";

const TEST_RESOURCES = { en: { common: enCommon, skills: enSkills, "skill-packages": enSkillPackages } };

vi.mock("@multica/core/api", () => ({
  api: { refreshSkill: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from "@multica/core/api";
import { toast } from "sonner";
import { UpdateSkillsDialog } from "./skill-list-actions";

const refreshSkill = vi.mocked(api.refreshSkill);

function makeRow(id: string): SkillRow {
  const skill: SkillSummary = {
    id,
    workspace_id: "ws-1",
    name: `skill-${id}`,
    description: "",
    config: {
      origin: { type: "github", source_url: `https://github.com/acme/${id}` },
    },
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  return {
    skill,
    agents: [],
    creator: null,
    runtime: null,
    originType: "github",
    canEdit: true,
  };
}

const ctx: SkillActionsContext = {
  wsId: "ws-1",
  agents: [],
  currentUserId: "user-1",
  isAdmin: true,
};

function renderDialog(
  rows: SkillRow[],
  skippedCount = 0,
  onUpdated?: () => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <UpdateSkillsDialog
          rows={rows}
          skippedCount={skippedCount}
          ctx={ctx}
          open
          onOpenChange={() => {}}
          onUpdated={onUpdated}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UpdateSkillsDialog diagnostics (OL-104 rework)", () => {
  const diagnostic = {
    code: "filtered_reference",
    path: "assets/logo.svg",
    target: "references/setup.md",
    message: "Binary asset was skipped.",
    retryable: false,
  };

  it("groups success notices by skill name instead of a bare toast", async () => {
    refreshSkill.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        diagnostics: id === "b" ? [diagnostic] : [],
      } as never),
    );
    const onUpdated = vi.fn();
    renderDialog([makeRow("a"), makeRow("b")], 0, onUpdated);

    await userEvent.click(await screen.findByRole("button", { name: /Update 2/ }));

    expect(await screen.findByText("Updated with 1 notice")).toBeTruthy();
    // The notice carries its skill's name — a bare list would be
    // unattributable in a mixed batch.
    expect(screen.getByText("skill-b")).toBeTruthy();
    expect(screen.getByText(/Binary asset was skipped/)).toBeTruthy();
    // Path and target survive into the batch view, matching the
    // single-import SkillDiagnosticRows rendering.
    expect(screen.getByText(/filtered_reference/)).toBeTruthy();
    expect(screen.getByText(/assets\/logo\.svg/)).toBeTruthy();
    expect(screen.getByText(/references\/setup\.md/)).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onUpdated).toHaveBeenCalled();
  });

  it("keeps collected notices visible after a partial failure instead of discarding them", async () => {
    refreshSkill.mockImplementation((id: string) =>
      id === "a"
        ? Promise.reject(new Error("name conflict"))
        : Promise.resolve({ id, diagnostics: [diagnostic] } as never),
    );
    const onUpdated = vi.fn();
    renderDialog([makeRow("a"), makeRow("b")], 0, onUpdated);

    await userEvent.click(await screen.findByRole("button", { name: /Update 2/ }));

    // Partial line + the successful item's notices, in one place.
    expect(await screen.findByText(/Updated 1, 1 failed/)).toBeTruthy();
    expect(screen.getByText(/Binary asset was skipped/)).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    // Partial runs keep the selection for retry.
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
