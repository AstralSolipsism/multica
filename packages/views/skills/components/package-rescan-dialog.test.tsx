// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillPackage, SkillPackagePreview } from "@multica/core/api/schemas";
import { ApiError } from "@multica/core/api/client";
import { renderWithI18n } from "../../test/i18n";

const apiMock = vi.hoisted(() => ({
  rescanSkillPackage: vi.fn(),
  applySkillPackageRescan: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  api: apiMock,
  errorCode: (err: unknown) =>
    err instanceof ApiError && err.body && typeof err.body === "object"
      ? (err.body as { code?: string }).code
      : undefined,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RescanPackageDialog } from "./package-rescan-dialog";

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

// Rescan defaults: only changed imported items are pre-selected; the new
// candidate stays an explicit opt-in; the removed path reports as retained.
const preview: SkillPackagePreview = {
  preview_id: "token-1",
  source: {
    url: "https://github.com/o/r/tree/main",
    owner_repo: "o/r",
    subdirectory: "",
    ref: "main",
    revision: "abc",
  },
  package: pkg,
  candidates: [
    {
      path: "skills/a", name: "alpha", description: "", state: "changed",
      default_selected: true, can_write: true, file_count: 1, bytes: 10,
      shared_files: [], diagnostics: [],
    },
    {
      path: "skills/b", name: "beta", description: "", state: "new",
      default_selected: false, can_write: true, file_count: 1, bytes: 10,
      shared_files: [], diagnostics: [],
    },
    {
      path: "skills/gone", name: "gamma", description: "", state: "removed",
      default_selected: false, can_write: false, file_count: 0, bytes: 0,
      shared_files: [], diagnostics: [],
    },
  ],
  diagnostics: [],
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <RescanPackageDialog wsId="ws-1" pkg={pkg} open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.rescanSkillPackage.mockResolvedValue(preview);
});

describe("RescanPackageDialog", () => {
  it("rescans with an empty body by default and shows server-driven selection", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));

    expect(apiMock.rescanSkillPackage).toHaveBeenCalledWith("ws-1", "p1", undefined);
    const alpha = await screen.findByRole("button", { name: /alpha/ });
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    // New candidate: visible but explicitly opt-in.
    const beta = screen.getByRole("button", { name: /beta/ });
    expect(beta.getAttribute("aria-pressed")).toBe("false");
    // Removed path: retained, not selectable.
    expect(screen.queryByRole("button", { name: /gamma/ })).toBeNull();
    expect(screen.getByText("Gone from the source; kept on apply.")).toBeTruthy();
  });

  it("applies through the rescan endpoint with the preview's source URL", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await screen.findByRole("button", { name: /alpha/ });

    apiMock.applySkillPackageRescan.mockResolvedValue({
      package: pkg,
      results: [
        { path: "skills/a", status: "updated", skill_id: "s1", retryable: false, diagnostics: [] },
        { path: "skills/b", status: "skipped", code: "not_selected", retryable: false, diagnostics: [] },
        { path: "skills/gone", status: "retained", code: "source_removed", retryable: false, diagnostics: [] },
      ],
      failed: false,
      diagnostics: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));

    // The apply must echo the preview's canonical URL — without it the
    // server falls back to the saved URL and reports preview_stale.
    expect(apiMock.applySkillPackageRescan).toHaveBeenCalledWith("ws-1", "p1", {
      url: "https://github.com/o/r/tree/main",
      preview_id: "token-1",
      skills: ["skills/a"],
      on_conflict: "skip",
    });
    expect(await screen.findByText("Updated")).toBeTruthy();
    expect(screen.getByText("Kept")).toBeTruthy();
  });

  it("applies a ref-overridden preview against the overridden source", async () => {
    renderDialog();
    await userEvent.type(
      screen.getByPlaceholderText("https://github.com/owner/repo/tree/branch"),
      "https://github.com/o/r/tree/dev",
    );
    const overridden: SkillPackagePreview = {
      ...preview,
      preview_id: "token-dev",
      source: { ...preview.source, url: "https://github.com/o/r/tree/dev", ref: "dev" },
    };
    apiMock.rescanSkillPackage.mockResolvedValue(overridden);
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await screen.findByRole("button", { name: /alpha/ });

    apiMock.applySkillPackageRescan.mockResolvedValue({
      package: { ...pkg, ref: "dev" },
      results: [
        { path: "skills/a", status: "updated", skill_id: "s1", retryable: false, diagnostics: [] },
      ],
      failed: false,
      diagnostics: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Import 1 skill" }));
    expect(apiMock.applySkillPackageRescan).toHaveBeenCalledWith("ws-1", "p1", {
      url: "https://github.com/o/r/tree/dev",
      preview_id: "token-dev",
      skills: ["skills/a"],
      on_conflict: "skip",
    });
  });

  it("passes a ref override URL only when given", async () => {
    renderDialog();
    await userEvent.type(
      screen.getByPlaceholderText("https://github.com/owner/repo/tree/branch"),
      "https://github.com/o/r/tree/dev",
    );
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(apiMock.rescanSkillPackage).toHaveBeenCalledWith("ws-1", "p1", {
      url: "https://github.com/o/r/tree/dev",
    });
  });

  // The shared apply stage classifies structured source errors identically
  // from the rescan entry (OL-104 rework): a 504 is a complete server answer
  // about the source, not an unreadable response.
  it("shows the source-failure title for a 504 source_timeout during apply", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await screen.findByRole("button", { name: /alpha/ });

    apiMock.applySkillPackageRescan.mockRejectedValue(
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
    expect(screen.getByText(/source scan timed out or was canceled/)).toBeTruthy();
    expect(screen.queryByText("Couldn't read the server response")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview again" })).toBeTruthy();
    expect(apiMock.applySkillPackageRescan).toHaveBeenCalledTimes(1);
  });
});
