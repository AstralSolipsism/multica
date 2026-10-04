// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillSummary } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import type { SkillRow } from "./skill-list-filter";
import type { SkillActionsContext } from "./skill-list-actions";

vi.mock("@multica/core/api", () => ({ api: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./refresh-skill-dialog", () => ({ RefreshSkillDialog: () => null }));
vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspacePaths: () => ({ skillDetail: (id: string) => `/acme/skills/${id}` }),
}));

import { SkillBatchToolbar, SkillRowActions } from "./skill-list-actions";

function makeRow(id: string): SkillRow {
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
  return { skill, agents: [], creator: null, runtime: null, originType: "manual", canEdit: true };
}

function makeAdapter(): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/skills",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (p) => p,
    openInNewTab: vi.fn(),
  };
}

function readOnly(row: SkillRow): SkillRow {
  return { ...row, canEdit: false };
}

// `unplacedIds` have no placement at all (ordinary skills); every other id
// not in `packagedIds` is placed without a package (detached or custom).
function makeCtx(packagedIds: string[] = [], unplacedIds: string[] = []) {
  const onMove = vi.fn();
  const onDetach = vi.fn();
  const ctx: SkillActionsContext = {
    wsId: "ws-1",
    agents: [],
    currentUserId: "u1",
    isAdmin: true,
    treeActions: {
      placementFor: (skillId) =>
        packagedIds.includes(skillId)
          ? { package_id: "p1" }
          : unplacedIds.includes(skillId)
            ? null
            : { package_id: null },
      onMove,
      onDetach,
    },
  };
  return { ctx, onMove, onDetach };
}

const NO_PERMISSION_HINT = "You don't have permission to move every selected skill.";
const PACKAGED_HINT = "Packaged skills can't be moved. Detach from the package first.";

function renderWithNav(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={qc}>
      <NavigationProvider value={makeAdapter()}>{ui}</NavigationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SkillRowActions move gating (OL-104 rework)", () => {
  it("disables move for a packaged skill with the detach-first hint", async () => {
    const { ctx, onMove } = makeCtx(["s1"]);
    renderWithNav(<SkillRowActions row={makeRow("s1")} ctx={ctx} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));

    const hint = await screen.findByText(
      "Packaged skills can't be moved. Detach from the package first.",
    );
    expect(hint.closest("[data-disabled]")).toBeTruthy();
    // The detach escape hatch sits right beside it.
    expect(screen.getByText("Detach from package")).toBeTruthy();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("keeps move enabled for an ordinary or already-detached skill", async () => {
    const { ctx, onMove } = makeCtx([]);
    const row = makeRow("s1");
    renderWithNav(<SkillRowActions row={row} ctx={ctx} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByText("Move skill"));
    expect(onMove).toHaveBeenCalledWith([row]);
  });
});

describe("SkillBatchToolbar move gating (OL-104 rework)", () => {
  it("disables batch move when any selected skill is packaged (mixed batch)", async () => {
    const { ctx } = makeCtx(["s2"]);
    renderWithNav(
      <SkillBatchToolbar rows={[makeRow("s1"), makeRow("s2")]} ctx={ctx} onClear={vi.fn()} />,
    );
    const move = await screen.findByRole("button", { name: "Move" });
    expect(move.hasAttribute("disabled")).toBe(true);
  });

  it("enables batch move once every selected skill is detached or ordinary", async () => {
    const { ctx, onMove } = makeCtx([]);
    const rows = [makeRow("s1"), makeRow("s2")];
    renderWithNav(<SkillBatchToolbar rows={rows} ctx={ctx} onClear={vi.fn()} />);
    const move = await screen.findByRole("button", { name: "Move" });
    expect(move.hasAttribute("disabled")).toBe(false);
    await userEvent.click(move);
    expect(onMove).toHaveBeenCalledWith(rows);
  });

  // Permission gate (OL-107 review): any selected skill the user cannot edit
  // blocks the whole move, whatever its package state, and the tooltip says
  // why. The server would reject those items.
  it.each([
    ["ordinary", ["s1", "s2"]],
    ["detached", []],
  ])(
    "disables batch move for a read-only %s selection with the permission hint",
    async (_kind, unplacedIds) => {
      const { ctx, onMove } = makeCtx([], unplacedIds);
      renderWithNav(
        <SkillBatchToolbar
          rows={[readOnly(makeRow("s1")), readOnly(makeRow("s2"))]}
          ctx={ctx}
          onClear={vi.fn()}
        />,
      );
      const move = await screen.findByRole("button", { name: "Move" });
      expect(move.hasAttribute("disabled")).toBe(true);
      await userEvent.click(move);
      expect(onMove).not.toHaveBeenCalled();

      await userEvent.hover(move.parentElement!);
      expect(await screen.findByText(NO_PERMISSION_HINT, {}, { timeout: 3000 })).toBeTruthy();
      expect(screen.queryByText(PACKAGED_HINT)).toBeNull();
    },
  );

  it("disables batch move for a mix of editable and read-only skills", async () => {
    const { ctx, onMove } = makeCtx([], ["s1"]);
    renderWithNav(
      <SkillBatchToolbar
        rows={[makeRow("s1"), readOnly(makeRow("s2"))]}
        ctx={ctx}
        onClear={vi.fn()}
      />,
    );
    const move = await screen.findByRole("button", { name: "Move" });
    expect(move.hasAttribute("disabled")).toBe(true);
    await userEvent.click(move);
    expect(onMove).not.toHaveBeenCalled();

    await userEvent.hover(move.parentElement!);
    expect(await screen.findByText(NO_PERMISSION_HINT, {}, { timeout: 3000 })).toBeTruthy();
  });

  it("names the packaged block first when the batch is also read-only", async () => {
    const { ctx, onMove } = makeCtx(["s2"]);
    renderWithNav(
      <SkillBatchToolbar
        rows={[readOnly(makeRow("s1")), makeRow("s2")]}
        ctx={ctx}
        onClear={vi.fn()}
      />,
    );
    const move = await screen.findByRole("button", { name: "Move" });
    expect(move.hasAttribute("disabled")).toBe(true);
    await userEvent.click(move);
    expect(onMove).not.toHaveBeenCalled();

    await userEvent.hover(move.parentElement!);
    expect(await screen.findByText(PACKAGED_HINT, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText(NO_PERMISSION_HINT)).toBeNull();
  });
});
