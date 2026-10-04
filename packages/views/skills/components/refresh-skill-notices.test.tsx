// @vitest-environment jsdom

// Labrastro fork tests for refresh-skill-notices.tsx (single refresh). Moved
// from refresh-skill-dialog.test.tsx in OL-107: harness copied, assertions
// unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Skill, SkillSummary } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";
import enSkillPackages from "../../locales/en/skill-packages.json";
import type { OriginInfo } from "../lib/origin";

const TEST_RESOURCES = { en: { common: enCommon, skills: enSkills, "skill-packages": enSkillPackages } };

vi.mock("@multica/core/api", () => ({
  api: { refreshSkill: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from "@multica/core/api";
import { toast } from "sonner";
import { RefreshSkillDialog } from "./refresh-skill-dialog";

const skill: SkillSummary = {
  id: "skill-1",
  workspace_id: "ws-1",
  name: "animations",
  description: "",
  config: {},
  created_by: "user-1",
  created_at: "2026-07-28T18:11:37Z",
  updated_at: "2026-07-28T18:14:40Z",
};

function renderDialog(origin: OriginInfo | null, onRefreshed?: (s: Skill) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={queryClient}>
        <RefreshSkillDialog
          skill={skill}
          origin={origin}
          wsId="ws-1"
          open
          onOpenChange={() => {}}
          onRefreshed={onRefreshed}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RefreshSkillDialog diagnostics", () => {
  const refreshSkill = vi.mocked(api.refreshSkill);

  it("keeps the dialog open with source notices instead of a bare success toast", async () => {
    const refreshed: Skill = {
      ...(skill as Skill),
      content: "",
      files: [],
      diagnostics: [
        {
          code: "filtered_reference",
          path: "assets/logo.svg",
          message: "Binary asset was skipped.",
          retryable: false,
        },
      ],
    };
    refreshSkill.mockResolvedValue(refreshed);
    const onRefreshed = vi.fn();
    renderDialog({ type: "github", source_url: "https://github.com/o/r" }, onRefreshed);

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByText("Updated with 1 notice")).toBeTruthy();
    expect(screen.getByText("Binary asset was skipped.")).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefreshed).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRefreshed).toHaveBeenCalledWith(refreshed);
  });

  it("closes with a toast when the refresh carries no diagnostics", async () => {
    const refreshed: Skill = { ...(skill as Skill), content: "", files: [], diagnostics: [] };
    refreshSkill.mockResolvedValue(refreshed);
    renderDialog({ type: "github", source_url: "https://github.com/o/r" });

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByText(/notice/)).toBeNull();
  });
});
