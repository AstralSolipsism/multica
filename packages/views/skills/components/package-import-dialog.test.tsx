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
vi.mock("@multica/core/skills/package-queries", () => ({
  invalidateSkillPackageQueries: vi.fn(async () => {}),
}));

import { invalidateSkillPackageQueries } from "@multica/core/skills/package-queries";
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

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <ImportPackageDialog wsId="ws-1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

async function reachChecklist(custom: SkillPackagePreview = preview, onOpenChange = vi.fn()) {
  apiMock.previewSkillPackage.mockResolvedValue(custom);
  renderDialog(onOpenChange);
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

describe("ImportPackageDialog apply error classification (OL-104 rework)", () => {
  // Mirrors the OL-103 d8a51e11 wire shapes: a complete, structured server
  // answer must not render under the "couldn't read the response" title.
  it("shows the source-failure title for a 504 source_timeout, keeping the server detail", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockRejectedValue(
      new ApiError(
        "skill package source scan timed out or was canceled; preview again",
        504,
        "Gateway Timeout",
        {
          error: "skill package source scan timed out or was canceled; preview again",
          code: "source_timeout",
          retryable: true,
        },
      ),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("Couldn't read the source")).toBeTruthy();
    expect(
      screen.getByText(/source scan timed out or was canceled/),
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't read the server response")).toBeNull();
    // Explicit re-preview stays the only recovery; no write was retried.
    expect(screen.getByRole("button", { name: "Preview again" })).toBeTruthy();
    expect(apiMock.applySkillPackage).toHaveBeenCalledTimes(1);
    expect(invalidateSkillPackageQueries).toHaveBeenCalled();
  });

  it("shows the source-failure title for a 503 source_unavailable", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockRejectedValue(
      new ApiError("could not fetch candidate: connection refused", 503, "Service Unavailable", {
        error: "could not fetch candidate: connection refused",
        code: "source_unavailable",
        diagnostics: [
          { code: "source_unavailable", message: "could not fetch candidate: connection refused", retryable: true },
        ],
        retryable: true,
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("Couldn't read the source")).toBeTruthy();
    expect(screen.getByText(/connection refused/)).toBeTruthy();
    expect(screen.queryByText("Couldn't read the server response")).toBeNull();
  });

  it("classifies tree_unavailable as a source failure too", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockRejectedValue(
      new ApiError("could not read the repository tree", 503, "Service Unavailable", {
        error: "could not read the repository tree",
        code: "tree_unavailable",
        retryable: true,
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("Couldn't read the source")).toBeTruthy();
    expect(screen.queryByText("Couldn't read the server response")).toBeNull();
  });

  it("shows the request-failed title for other structured server errors", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockRejectedValue(
      new ApiError("skill package operation failed", 500, "Internal Server Error", {
        error: "skill package operation failed",
        code: "operation_failed",
        retryable: true,
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("The request failed")).toBeTruthy();
    expect(screen.getByText(/operation failed/)).toBeTruthy();
    expect(screen.queryByText("Couldn't read the server response")).toBeNull();
    expect(screen.queryByText("Couldn't read the source")).toBeNull();
  });

  it("keeps body-less network/proxy errors on the unreadable-response path", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockRejectedValue(new TypeError("fetch failed"));
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    expect(await screen.findByText("Couldn't read the server response")).toBeTruthy();
    expect(screen.getByText("fetch failed")).toBeTruthy();
    expect(screen.queryByText("Couldn't read the source")).toBeNull();
  });
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

describe("ImportPackageDialog forbidden candidates (OL-104 rework)", () => {
  it("never pre-checks or submits a forbidden candidate, and explains why", async () => {
    await reachChecklist({
      ...preview,
      candidates: [
        candidate({ path: "skills/ok", name: "okay", default_selected: true }),
        // The server can default-select these (manifest/rescan), and an
        // explicit submission would deterministically fail.
        candidate({
          path: "skills/no",
          name: "nope",
          state: "adoptable",
          conflict: "forbidden",
          default_selected: true,
          can_write: false,
        }),
      ],
    });
    // No toggle at all, with the permission reason stated beside the row.
    expect(screen.queryByRole("button", { name: /nope/ })).toBeNull();
    expect(
      screen.getByText("No permission on the existing skill; it stays skipped."),
    ).toBeTruthy();

    apiMock.applySkillPackage.mockResolvedValue({
      results: [
        { path: "skills/ok", status: "created", skill_id: "s1", retryable: false, diagnostics: [] },
        { path: "skills/no", status: "skipped", code: "not_selected", retryable: false, diagnostics: [] },
      ],
      failed: false,
      diagnostics: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));
    expect(apiMock.applySkillPackage).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ skills: ["skills/ok"] }),
    );
  });
});

describe("ImportPackageDialog close blocking during apply (OL-104 rework)", () => {
  it("blocks X, Escape and outside click while a write is in flight", async () => {
    const onOpenChange = vi.fn();
    await reachChecklist(preview, onOpenChange);

    let resolveApply!: (value: unknown) => void;
    apiMock.applySkillPackage.mockImplementation(
      () => new Promise((resolve) => { resolveApply = resolve; }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));
    expect(await screen.findByText("Importing...")).toBeTruthy();

    // Every close path must be refused while the write runs.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toBeTruthy();
    await userEvent.pointer({ keys: "[MouseLeft]", target: overlay as Element });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Importing...")).toBeTruthy();

    // Once the write lands, the full per-item report is still there to read.
    resolveApply({
      results: [
        { path: "skills/a", status: "created", skill_id: "s1", retryable: false, diagnostics: [] },
        { path: "skills/c", status: "failed", code: "candidate_failed", reason: "boom", retryable: true, diagnostics: [] },
      ],
      failed: true,
      diagnostics: [],
    });
    expect(await screen.findByText("Some items failed. Preview again to retry them.")).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
  });
});

describe("ImportPackageDialog settle invalidation (OL-104 rework)", () => {
  beforeEach(() => {
    vi.mocked(invalidateSkillPackageQueries).mockClear();
  });

  it("invalidates tree/package/skills/agents after a partial-failure report", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockResolvedValue({
      results: [
        { path: "skills/a", status: "created", skill_id: "s1", retryable: false, diagnostics: [] },
        { path: "skills/b", status: "failed", code: "item_failed", retryable: true, diagnostics: [] },
      ],
      failed: true,
      diagnostics: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));
    await screen.findByText("Some items failed. Preview again to retry them.");
    expect(invalidateSkillPackageQueries).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      { includeSkills: true },
    );
  });

  it("invalidates after malformed and thrown-error settles too", async () => {
    await reachChecklist();
    apiMock.applySkillPackage.mockResolvedValue(null);
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));
    await screen.findByText(/never repeat a write blindly/);
    expect(invalidateSkillPackageQueries).toHaveBeenCalled();
  });
});

describe("ImportPackageDialog overwrite fallback (OL-104 rework)", () => {
  it("falls back to skip when overwrite becomes unavailable after selection", async () => {
    await reachChecklist({
      ...preview,
      candidates: [
        candidate({ path: "skills/own", name: "own", state: "conflict", conflict: "name_conflict", can_write: true, default_selected: true }),
        candidate({ path: "skills/foreign", name: "foreign", state: "conflict", conflict: "name_conflict", can_write: false }),
      ],
    });
    // Overwrite is allowed while only the ownable conflict is selected.
    const overwrite = await screen.findByRole("radio", { name: "Overwrite" });
    await userEvent.click(overwrite);
    expect((overwrite as HTMLInputElement).checked).toBe(true);

    // Selecting the uncoverable conflict disables AND unchecks overwrite.
    await userEvent.click(screen.getByRole("button", { name: /foreign/ }));
    const overwriteAfter = screen.getByRole("radio", { name: "Overwrite" }) as HTMLInputElement;
    expect(overwriteAfter.disabled).toBe(true);
    expect(overwriteAfter.checked).toBe(false);

    apiMock.applySkillPackage.mockResolvedValue({
      results: [], failed: false, diagnostics: [],
    });
    await userEvent.click(screen.getByRole("button", { name: "Import 2 skills" }));
    await waitFor(() =>
      expect(apiMock.applySkillPackage).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ on_conflict: "skip" }),
      ),
    );
  });
});
