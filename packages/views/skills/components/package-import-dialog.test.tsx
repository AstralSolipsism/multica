// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillPackageCandidate, SkillPackagePreview } from "@multica/core/api/schemas";
import { ApiError } from "@multica/core/api/client";
import { renderWithI18n } from "../../test/i18n";

const apiMock = vi.hoisted(() => ({
  previewSkillPackage: vi.fn(),
  applySkillPackage: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: apiMock,
  errorCode: (err: unknown) =>
    err instanceof ApiError && err.body && typeof err.body === "object"
      ? (err.body as { code?: string }).code
      : undefined,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ImportPackageDialog } from "./package-import-dialog";

function candidate(partial: Partial<SkillPackageCandidate> & { path: string }): SkillPackageCandidate {
  return {
    name: partial.path,
    description: "",
    default_selected: false,
    state: "new",
    can_write: true,
    file_count: 0,
    bytes: 0,
    shared_files: [],
    diagnostics: [],
    ...partial,
  };
}

const preview: SkillPackagePreview = {
  preview_id: "token-1",
  source: {
    url: "https://github.com/o/r/tree/main",
    owner_repo: "o/r",
    subdirectory: "",
    ref: "main",
    revision: "abc",
  },
  candidates: [
    candidate({ path: "skills/a", name: "alpha", default_selected: true }),
    candidate({ path: "skills/b", name: "beta", default_selected: false }),
    candidate({ path: "skills/c", name: "gamma", state: "unknown", can_write: false }),
    candidate({ path: "skills/d", name: "delta", state: "removed" }),
  ],
  diagnostics: [],
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <ImportPackageDialog wsId="ws-1" open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function reachChecklist(custom: SkillPackagePreview = preview) {
  apiMock.previewSkillPackage.mockResolvedValue(custom);
  renderDialog();
  await userEvent.type(
    screen.getByPlaceholderText("https://github.com/owner/repo"),
    "https://github.com/o/r",
  );
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  // The source summary marks the checklist phase for any preview shape.
  return screen.findByText("o/r");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ImportPackageDialog preview", () => {
  it("checks the server defaults, leaves opt-ins unchecked, and never checks unknown states", async () => {
    await reachChecklist();
    const alpha = await screen.findByRole("button", { name: /alpha/ });
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    const beta = screen.getByRole("button", { name: /beta/ });
    expect(beta.getAttribute("aria-pressed")).toBe("false");
    // Unknown candidates render no toggle at all.
    expect(screen.queryByRole("button", { name: /gamma/ })).toBeNull();
    expect(screen.getByText("Unrecognized state; can't be selected.")).toBeTruthy();
    // Removed candidates explain their retention instead of a checkbox.
    expect(screen.queryByRole("button", { name: /delta/ })).toBeNull();
    expect(screen.getByText("Gone from the source; kept on apply.")).toBeTruthy();
  });

  it("shows the same-name warning when several selected candidates share a name", async () => {
    await reachChecklist({
      ...preview,
      candidates: [
        candidate({ path: "a/dup", name: "dup", default_selected: true }),
        candidate({ path: "b/dup", name: "dup", default_selected: true }),
      ],
    });
    expect(
      await screen.findByText(/Several selected candidates are named/),
    ).toBeTruthy();
  });

  it("keeps a malformed preview indeterminate instead of showing an empty checklist", async () => {
    apiMock.previewSkillPackage.mockResolvedValue(null);
    renderDialog();
    await userEvent.type(
      screen.getByPlaceholderText("https://github.com/owner/repo"),
      "https://github.com/o/r",
    );
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText("The response was incomplete or unexpected. Nothing was written."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /alpha/ })).toBeNull();
  });
});

describe("ImportPackageDialog apply", () => {
  it("applies the checked selection and renders the full per-item report, including failures", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockResolvedValue({
      package: undefined,
      results: [
        { path: "skills/a", status: "created", skill_id: "s1", retryable: false, diagnostics: [] },
        { path: "skills/b", status: "skipped", code: "not_selected", retryable: false, diagnostics: [] },
        { path: "skills/c", status: "failed", code: "candidate_failed", reason: "download failed", retryable: true, diagnostics: [] },
      ],
      failed: true,
      diagnostics: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("Some items failed. Preview again to retry them.")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.getByText(/download failed/)).toBeTruthy();
    // The apply carried exactly the checked paths with the default strategy.
    expect(apiMock.applySkillPackage).toHaveBeenCalledWith("ws-1", {
      url: "https://github.com/o/r/tree/main",
      preview_id: "token-1",
      skills: ["skills/a"],
      on_conflict: "skip",
    });
  });

  it("recovers a stale preview through an explicit re-preview, never a blind retry", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockRejectedValue(
      new ApiError("stale", 409, "Conflict", { code: "preview_stale" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("This preview is out of date")).toBeTruthy();
    expect(apiMock.applySkillPackage).toHaveBeenCalledTimes(1);
    apiMock.previewSkillPackage.mockResolvedValue({ ...preview, preview_id: "token-2" });
    await userEvent.click(screen.getByRole("button", { name: "Preview again" }));
    // A fresh checklist appears from the new token; apply was NOT retried.
    await waitFor(() =>
      expect(apiMock.previewSkillPackage).toHaveBeenCalledTimes(2),
    );
    expect(apiMock.applySkillPackage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("alpha")).toBeTruthy();
  });

  it("treats an unreadable apply result as indeterminate, not success", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockResolvedValue(null);
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));
    expect(
      await screen.findByText(/never repeat a write blindly/),
    ).toBeTruthy();
    expect(screen.queryByText(/Everything selected was applied/)).toBeNull();
  });

  it("offers the conflict strategy only with a conflict selected, and gates overwrite on permission", async () => {
    await reachChecklist({
      ...preview,
      candidates: [
        candidate({ path: "skills/x", name: "xray", state: "conflict", conflict: "name_conflict", can_write: false, default_selected: true }),
      ],
    });
    const overwrite = await screen.findByRole("radio", { name: "Overwrite" });
    expect((overwrite as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText("Overwrite needs permission on every conflicting skill."),
    ).toBeTruthy();

    // Rename never needs can_write: choosing it applies with on_conflict=rename.
    apiMock.applySkillPackage.mockResolvedValue({
      results: [{ path: "skills/x", status: "created", skill_id: "s9", retryable: false, diagnostics: [] }],
      failed: false,
      diagnostics: [],
    });
    await userEvent.click(screen.getByRole("radio", { name: "Import as copy" }));
    await userEvent.click(screen.getByRole("button", { name: "Import 1 skill" }));
    await waitFor(() =>
      expect(apiMock.applySkillPackage).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ on_conflict: "rename" }),
      ),
    );
  });
});
