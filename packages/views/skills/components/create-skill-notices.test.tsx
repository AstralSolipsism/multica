// Labrastro fork tests for create-skill-notices.tsx (import notices and
// multi-skill wording). Moved from create-skill-dialog.test.tsx in OL-107:
// harness copied, assertions unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";
import enSkillPackages from "../../locales/en/skill-packages.json";

const TEST_RESOURCES = {
  en: { common: enCommon, skills: enSkills, "skill-packages": enSkillPackages },
};

const mockImportSkillArchive = vi.hoisted(() => vi.fn());
const mockPrepareFromPicker = vi.hoisted(() => vi.fn());
const mockWrap = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    importSkillArchive: (...args: unknown[]) => mockImportSkillArchive(...args),
  },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/skills", async () => {
  const actual = await vi.importActual<
    typeof import("@multica/core/skills")
  >("@multica/core/skills");
  return {
    ...actual,
    prepareSkillArchiveFromPickerFiles: (...args: unknown[]) =>
      mockPrepareFromPicker(...args),
    wrapExistingSkillArchive: (...args: unknown[]) => mockWrap(...args),
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { CreateSkillDialog } from "./create-skill-dialog";

const ARCHIVE_FILE = new File(["pk"], "review-helper.skill", {
  type: "application/zip",
});

const PREPARED_OK = {
  ok: true as const,
  file: ARCHIVE_FILE,
  preview: {
    displayName: "review-helper",
    skillName: "review-helper",
    description: "Reviews code changes",
    fileCount: 2,
    source: "folder" as const,
  },
};

function renderDialog(onCreated = vi.fn(), onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onCreated,
    onClose,
    ...render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={queryClient}>
          <CreateSkillDialog onClose={onClose} onCreated={onCreated} />
        </QueryClientProvider>
      </I18nProvider>,
    ),
  };
}

describe("CreateSkillDialog local import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareFromPicker.mockResolvedValue(PREPARED_OK);
    mockWrap.mockReturnValue({
      ...PREPARED_OK,
      preview: { ...PREPARED_OK.preview, source: "archive", fileCount: null },
    });
    mockImportSkillArchive.mockResolvedValue({
      id: "skill-1",
      workspace_id: "ws-1",
      name: "review-helper",
      description: "Reviews code changes",
      content: "# Review Helper",
      config: {},
      files: [],
      created_by: "user-1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  });

  // OL-106: a folder holding sibling skills used to import just one of them
  // silently. It is now rejected up front with guidance towards a single-skill
  // folder or the repository-based Import package entry.
  it("blocks a folder holding sibling skills with localized guidance", async () => {
    mockPrepareFromPicker.mockResolvedValue({ ok: false, error: "multiple_skills" });
    renderDialog();

    const input = document.querySelector(
      'input[type="file"][multiple]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["a"], "SKILL.md")] } });

    expect(
      await screen.findByText(/This selection contains multiple skills/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Import package/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import$/i })).toBeDisabled();
    expect(mockImportSkillArchive).not.toHaveBeenCalled();
  });

  // The server rejects a multi-skill .skill/.zip with an English sentence
  // aimed at the CLI; the dialog must show the same localized recovery as the
  // folder path instead of that raw message (OL-106).
  it("maps the server multi-skill archive rejection to the same guidance", async () => {
    mockImportSkillArchive.mockRejectedValueOnce(
      new Error(
        "archive contains multiple skills; use multica skill package import <repository-url>",
      ),
    );
    renderDialog();

    const archiveInput = document.querySelector(
      'input[type="file"][accept]',
    ) as HTMLInputElement;
    fireEvent.change(archiveInput, { target: { files: [ARCHIVE_FILE] } });
    expect((await screen.findAllByText("review-helper")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }));

    expect(
      await screen.findByText(/This selection contains multiple skills/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/archive contains multiple skills/i),
    ).not.toBeInTheDocument();
    // Other server errors still pass through unchanged.
    mockImportSkillArchive.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("shows source diagnostics after a successful import instead of closing", async () => {
    mockImportSkillArchive.mockResolvedValue({
      id: "skill-1",
      workspace_id: "ws-1",
      name: "review-helper",
      description: "Reviews code changes",
      content: "# Review Helper",
      config: {},
      files: [],
      diagnostics: [
        {
          code: "filtered_reference",
          path: "assets/logo.svg",
          message: "Binary asset was skipped.",
          retryable: false,
        },
      ],
      created_by: "user-1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const { onCreated, onClose } = renderDialog();

    const input = document.querySelector(
      'input[type="file"][multiple]',
    ) as HTMLInputElement;
    const file = new File(["---\nname: review-helper\n---\n"], "SKILL.md");
    fireEvent.change(input, { target: { files: [file] } });

    expect((await screen.findAllByText("review-helper")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }));

    // The notices step replaces the form; onCreated waits for the user.
    expect(await screen.findByText("Imported with 1 notice")).toBeTruthy();
    expect(screen.getByText("Binary asset was skipped.")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View skill" }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
  });

});
