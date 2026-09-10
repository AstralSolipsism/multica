import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import {
  configureShortcutPlatform,
  createShortcutChord,
  useShortcutStore,
} from "@multica/core/shortcuts";
import { RunConfirmModal } from "./run-confirm";
import { ApiError } from "@multica/core/api";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-test" }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({
  useIssueStatuses: () =>
    buildIssueStatusCatalog([
      {
        id: "rework",
        workspace_id: "ws-test",
        key: "rework",
        name: "Rework",
        description: "",
        category: "todo",
        color: "#22c55e",
        is_system: false,
        position: 0,
        archived_at: null,
        created_at: "",
        updated_at: "",
      },
    ]),
}));

const mockUpdate = vi.fn().mockResolvedValue({ id: "issue-1" });
const mockBatch = vi.fn().mockResolvedValue({ updated: 2 });
vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutateAsync: mockUpdate }),
  useBatchUpdateIssues: () => ({ mutateAsync: mockBatch }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Walt" }),
}));

// OL-44: the dependency preview hook is a thin react-query wrapper exercised
// in its own suite; here a holder drives exactly the answer the modal reads,
// and `refetch` stands in for "a fresh signed confirmation arrived".
const previewHolder = vi.hoisted(() => ({
  current: {
    triggers: [] as unknown[],
    totalCount: 0,
    blocked: null as null | unknown[],
    isLoading: false,
    isPlaceholderData: false,
    dataUpdatedAt: 0,
  },
  refetch: vi.fn(),
}));

vi.mock("../issues/hooks/use-issue-trigger-preview", () => ({
  useIssueTriggerPreview: () => ({ ...previewHolder.current, refetch: previewHolder.refetch }),
}));

// The blocked-prerequisite list is presentation (its own rendering is covered
// by the dependency-prerequisites/editor suites); the modal tests only need
// to see WHICH targets are blocked.
vi.mock("../issues/components/dependency-prerequisites", () => ({
  DependencyBlockedList: ({ items }: { items: { issueId: string }[] }) => (
    <div data-testid="blocked-list">{items.map((i) => i.issueId || "create").join(",")}</div>
  ),
}));

vi.mock("../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));

vi.mock("../i18n", () => ({
  useT: () => ({
    t: (
      sel: (x: Record<string, Record<string, string>>) => string,
      vars?: Record<string, unknown>,
    ) => {
      // Resolve the accessor against a flat label map so assertions can target
      // text, then interpolate {{name}} / {{count}} the way i18next would — the
      // headline substitutes the assignee name and the batch count.
      const labels = {
        run_confirm: {
          title_assign: "Confirm assignment?",
          assign_single: "assign to {{name}}",
          assign_batch: "assign {{count}} to {{name}}",
          confirm_assign: "Confirm assignment",
          dont_start: "Don't start yet",
          toast_failed: "failed",
          title_promote: "Start work now?",
          promote_single: "move to {{status}}, {{name}} starts",
          confirm_promote: "Move and start",
          blocked_title: "Prerequisites unfinished",
          blocked_one_time_note: "Confirming releases this one execution only.",
          override_assign: "Assign and start anyway",
          override_promote: "Move and start anyway",
          override_unavailable: "Your current sign-in can't release unfinished prerequisites.",
          stale_notice: "Prerequisites changed — confirm again.",
          expired_notice: "The previous confirmation expired.",
          title_partial: "Some issues couldn't be updated",
          close: "Close",
        },
        // blockedReasonLabel (batch failure rows) resolves through these.
        comment: {
          trigger_blocked_dependency_unsatisfied: "unfinished prerequisites",
          trigger_blocked_dependency_data_unverified: "dependency data unverified",
          trigger_blocked_generic: "won't be triggered",
        },
        // useStatusLabel resolves BUILT-IN keys through i18n and custom ones
        // through the catalog, so the promote headline needs both sources.
        status: { todo: "Todo" },
      };
      return sel(labels).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ""));
    },
  }),
}));

// Keep the ui primitives as light DOM so the logic is what's under test.
vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Keeps the real Popup's prop passthrough, which the send chord binds to.
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="dialog-content" {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@multica/ui/components/ui/spinner", () => ({
  Spinner: () => <span data-testid="spinner" />,
}));
// vi.hoisted: vi.mock factories run before module-level consts initialize.
// Only error is used now — completion is silent (no result toast).
const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

beforeEach(() => {
  mockUpdate.mockClear().mockResolvedValue({ id: "issue-1" });
  mockBatch.mockClear().mockResolvedValue({ updated: 2 });
  mockToast.error.mockClear();
  mockToast.success.mockClear();
  previewHolder.current = {
    triggers: [],
    totalCount: 0,
    blocked: null,
    isLoading: false,
    isPlaceholderData: false,
    dataUpdatedAt: 0,
  };
  previewHolder.refetch.mockClear();
  // The real shortcut store drives both the submit chord and the keycap hint,
  // and jsdom's platform follows the host OS — pin it so the chord is ⌘+Enter
  // everywhere, not Ctrl+Enter on a Linux CI runner.
  configureShortcutPlatform("macos");
  useShortcutStore.setState({ overrides: {} });
});

afterEach(() => {
  configureShortcutPlatform(null);
  useShortcutStore.setState({ overrides: {} });
});

const confirmButton = () => screen.getByRole("button", { name: "Confirm assignment" });
const dialog = () => screen.getByTestId("dialog-content");

const single = {
  issueIds: ["issue-1"],
  mode: "assign" as const,
  assigneeType: "agent" as const,
  assigneeId: "agent-1",
};

// Promoting a parked issue out of backlog starts the run on its own, so it
// confirms through this same dialog — one behaviour for built-in `todo` and
// every custom Todo-category status alike (MUL-6463).
const promote = {
  issueIds: ["issue-1"],
  mode: "promote" as const,
  status: "rework",
  assigneeType: "agent" as const,
  assigneeId: "agent-1",
};

describe("RunConfirmModal", () => {
  it("is fully operable on the first frame — no preview request, no spinner", () => {
    // The MUL-5010 core: opening the dialog fires nothing and blocks nothing.
    const { container } = render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
    expect(confirmButton()).not.toBeDisabled();
    // Headline reads across elements — the assignee name is bolded in place.
    expect(container.textContent).toContain("assign to Walt");
  });

  it("single assign sends the assignee change and nothing else", async () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
    });
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it("completes silently on success — closes with no result toast", async () => {
    // Final scope: the dialog only confirms the assignment. The assignee and any
    // run surface through the issue's normal updates, so submit adds no toast.
    const onClose = vi.fn();
    render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("'暂不开始' sends suppress_run alongside the assignee change", async () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.click(screen.getByText("Don't start yet"));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
      suppress_run: true,
    });
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("promote sends the status change with no assignee fields", async () => {
    // The owner is already on the issue: re-sending it would turn a status
    // write into an assignee write on the server's side of the predicate.
    render(<RunConfirmModal onClose={vi.fn()} data={promote} />);
    fireEvent.click(screen.getByRole("button", { name: "Move and start" }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      status: "rework",
    });
  });

  it("promote's 'don't start yet' still moves the issue, without the run", async () => {
    // The status change is the point; suppress_run is the only difference. This
    // is the one way to leave backlog WITHOUT waking the agent.
    render(<RunConfirmModal onClose={vi.fn()} data={promote} />);
    fireEvent.click(screen.getByText("Don't start yet"));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      status: "rework",
      suppress_run: true,
    });
  });

  it("promote names the target status the way the workspace named it", () => {
    // A custom status is only recognisable by its catalog name; built-ins keep
    // resolving through i18n so a zh workspace never reads "In Progress".
    const { container, rerender } = render(<RunConfirmModal onClose={vi.fn()} data={promote} />);
    expect(screen.getByText("Start work now?")).toBeInTheDocument();
    expect(container.textContent).toContain("move to Rework, Walt starts");

    rerender(<RunConfirmModal onClose={vi.fn()} data={{ ...promote, status: "todo" }} />);
    expect(container.textContent).toContain("move to Todo, Walt starts");
  });

  it("batch assign (N ids) applies via batchUpdate", async () => {
    const { container } = render(
      <RunConfirmModal onClose={vi.fn()} data={{ ...single, issueIds: ["i1", "i2"] }} />,
    );
    expect(container.textContent).toContain("assign 2 to Walt");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    expect(mockBatch).toHaveBeenCalledWith({
      ids: ["i1", "i2"],
      updates: { assignee_type: "agent", assignee_id: "agent-1" },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  // --- Send chord (MUL-5694) ------------------------------------------------
  // The chord is bound on the dialog, not on a single control, so it confirms
  // wherever focus happens to be.

  it("confirms on the send chord typed anywhere in the dialog", async () => {
    const onClose = vi.fn();
    render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("confirms from a focused footer button, which the chord cannot activate", async () => {
    // Chromium fires no click for ⌘/Ctrl+Enter on a focused button, so without
    // the dialog handling it there the chord is simply dead. The dialog focuses
    // its first tabbable child, which is now a footer button.
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(screen.getByText("Don't start yet"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    // The primary action, not the button the caret happened to sit on.
    expect(mockUpdate.mock.calls[0]![0].suppress_run).toBeUndefined();
  });

  it("yields to a focused button when send is remapped to plain Enter", () => {
    // A bare Enter DOES activate a focused button, so confirming here as well
    // would double-write — and on "Don't start yet" the two would disagree.
    useShortcutStore.setState({ overrides: { send: createShortcutChord("Enter") } });
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(screen.getByText("Don't start yet"), { key: "Enter" });
    fireEvent.keyDown(confirmButton(), { key: "Enter" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("submits once for a held chord, and never for an IME's committing Enter", async () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true, repeat: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  });

  it("follows a remapped send chord instead of hardcoding ⌘+Enter", async () => {
    useShortcutStore.setState({ overrides: { send: createShortcutChord("Enter") } });
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "Enter" });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  });

  it("shows the chord on the confirm button without renaming it", () => {
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    // Decorative: discoverable next to the label, absent from the a11y name —
    // `confirmButton()` resolving by that exact name is the assertion.
    expect(
      confirmButton().querySelector('[data-slot="shortcut-keycaps"]'),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open and surfaces the error when the write fails", async () => {
    const onClose = vi.fn();
    mockUpdate.mockRejectedValue(new Error("boom"));
    render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("boom"));
    expect(onClose).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});

// --- OL-44: dependency block + one-shot human override -----------------------
//
// The modal previews the exact prospective mutation; a dependency-blocked
// answer swaps the plain confirm for an explicit override that echoes the
// server-signed challenge. Stale/expired answers always re-preview — the
// human re-decides against current prerequisites, nothing auto-retries.

const blockedItem = (overrides: Record<string, unknown> = {}) => ({
  issueId: "issue-1",
  reasonCode: "dependency_unsatisfied",
  dependencies: {
    blockedBy: [],
    inheritedBlockedBy: [],
    blocking: [],
    unsatisfied: [
      {
        issueId: "issue-9",
        status: "in_progress",
        statusCategory: "in_progress",
        satisfied: false,
        sourceEdges: ["edge-1"],
        inheritedFrom: [],
        title: "Upstream",
        identifier: "MUL-9",
        descendantCount: 0,
      },
    ],
    hasRestrictedBlockers: false,
    dependencyVersion: "v1",
  },
  confirmation: {
    requestId: "req-1",
    challenge: "ch-1",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  },
  ...overrides,
});

const dependencyError = (reasonCode: string) =>
  new ApiError("conflict", 409, "Conflict", {
    error: "dependency refusal",
    reason_code: reasonCode,
  });

describe("RunConfirmModal — dependency override (OL-44)", () => {
  const overrideButton = () =>
    screen.getByRole("button", { name: "Assign and start anyway" });

  it("shows the blocked prerequisites and assigns anyway with the signed confirmation", async () => {
    previewHolder.current = { ...previewHolder.current, blocked: [blockedItem()] };
    const onClose = vi.fn();
    render(<RunConfirmModal onClose={onClose} data={single} />);

    // The blocked panel names the target, and the plain confirm is replaced
    // by the explicit one-shot override.
    expect(screen.getByTestId("blocked-list")).toHaveTextContent("issue-1");
    expect(screen.queryByRole("button", { name: "Confirm assignment" })).not.toBeInTheDocument();

    fireEvent.click(overrideButton());
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
      dependencyOverride: { requestId: "req-1", challenge: "ch-1" },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps 'don't start yet' available while blocked — without any override", async () => {
    previewHolder.current = { ...previewHolder.current, blocked: [blockedItem()] };
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);

    fireEvent.click(screen.getByText("Don't start yet"));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
      suppress_run: true,
    });
  });

  it("refreshes the preview instead of erroring when the plain write is refused mid-flight", async () => {
    // The preview had no block (slow preview / concurrently added edge), the
    // write 409s, and the modal asks again with fresh reasons + challenge.
    mockUpdate.mockRejectedValueOnce(dependencyError("dependency_unsatisfied"));
    const onClose = vi.fn();
    const { rerender } = render(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(previewHolder.refetch).toHaveBeenCalled());
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The fresh preview lands with the block + a confirmation.
    previewHolder.current = {
      ...previewHolder.current,
      blocked: [blockedItem()],
      dataUpdatedAt: 2,
    };
    rerender(<RunConfirmModal onClose={onClose} data={single} />);
    fireEvent.click(overrideButton());
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate).toHaveBeenLastCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
      dependencyOverride: { requestId: "req-1", challenge: "ch-1" },
    });
  });

  it("re-previews on a stale override and only the fresh challenge is accepted", async () => {
    previewHolder.current = { ...previewHolder.current, blocked: [blockedItem()] };
    mockUpdate.mockRejectedValueOnce(dependencyError("dependency_override_stale"));
    const { rerender } = render(<RunConfirmModal onClose={vi.fn()} data={single} />);

    fireEvent.click(overrideButton());
    await waitFor(() => expect(previewHolder.refetch).toHaveBeenCalled());

    // A fresh confirmation arrives; retrying submits THAT one, not the stale pair.
    previewHolder.current = {
      ...previewHolder.current,
      blocked: [
        blockedItem({
          confirmation: {
            requestId: "req-2",
            challenge: "ch-2",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          },
        }),
      ],
      dataUpdatedAt: 3,
    };
    rerender(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.click(overrideButton());
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate).toHaveBeenLastCalledWith({
      id: "issue-1",
      assignee_type: "agent",
      assignee_id: "agent-1",
      dependencyOverride: { requestId: "req-2", challenge: "ch-2" },
    });
  });

  it("offers no usable override affordance when the server signed no confirmation", async () => {
    previewHolder.current = {
      ...previewHolder.current,
      blocked: [blockedItem({ confirmation: null })],
    };
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);

    expect(screen.getByTestId("blocked-list")).toBeInTheDocument();
    // Capability is the server's: with no confirmation the action renders
    // disabled with the reason named, instead of promising an approval this
    // credential can't give.
    expect(overrideButton()).toBeDisabled();
    expect(screen.getByText(/can't release unfinished prerequisites/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Don't start yet"));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0]![0].dependencyOverride).toBeUndefined();
  });

  it("binds each batch item's own confirmation and reports refused items per issue", async () => {
    const second = blockedItem({
      issueId: "i2",
      confirmation: {
        requestId: "req-2",
        challenge: "ch-2",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    previewHolder.current = {
      ...previewHolder.current,
      blocked: [blockedItem({ issueId: "i1" }), second],
    };
    mockBatch.mockResolvedValueOnce({
      updated: 1,
      results: [
        {
          issueId: "i1",
          updated: true,
          dispatch: { status: "queued", reasonCode: "", taskId: "t1", runId: "r1" },
          dependencies: null,
        },
        {
          issueId: "i2",
          updated: false,
          reasonCode: "dependency_unsatisfied",
          dispatch: null,
          dependencies: null,
        },
      ],
    });
    const onClose = vi.fn();
    render(<RunConfirmModal onClose={onClose} data={{ ...single, issueIds: ["i1", "i2"] }} />);

    fireEvent.click(overrideButton());
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    expect(mockBatch).toHaveBeenCalledWith({
      ids: ["i1", "i2"],
      updates: { assignee_type: "agent", assignee_id: "agent-1" },
      dependencyOverrides: {
        i1: { requestId: "req-1", challenge: "ch-1" },
        i2: { requestId: "req-2", challenge: "ch-2" },
      },
    });

    // Partial batch: the modal stays open and names the refused item.
    await waitFor(() => expect(screen.getByText("i2")).toBeInTheDocument());
    expect(screen.getByText("Some issues couldn't be updated")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("disables the override once the challenge expires until a fresh one arrives", async () => {
    previewHolder.current = {
      ...previewHolder.current,
      blocked: [
        blockedItem({
          confirmation: {
            requestId: "req-old",
            challenge: "ch-old",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        }),
      ],
    };
    const { rerender } = render(<RunConfirmModal onClose={vi.fn()} data={single} />);

    // Expiry auto-refreshes the challenge and the override is unusable meanwhile.
    await waitFor(() => expect(previewHolder.refetch).toHaveBeenCalled());
    expect(overrideButton()).toBeDisabled();

    previewHolder.current = {
      ...previewHolder.current,
      blocked: [blockedItem()],
      dataUpdatedAt: 4,
    };
    rerender(<RunConfirmModal onClose={vi.fn()} data={single} />);
    await waitFor(() => expect(overrideButton()).not.toBeDisabled());
  });

  it("keeps the send chord inert while a dependency block is on screen", () => {
    // The override is a deliberate click on an explicitly labeled button —
    // never a reflexive ⌘⏎ (OL-44).
    previewHolder.current = { ...previewHolder.current, blocked: [blockedItem()] };
    render(<RunConfirmModal onClose={vi.fn()} data={single} />);
    fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
