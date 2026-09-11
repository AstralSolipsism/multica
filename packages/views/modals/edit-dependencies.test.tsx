"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditDependenciesModal } from "./edit-dependencies";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  search: vi.fn(),
  openModal: vi.fn(),
  push: vi.fn(),
  setQueryData: vi.fn(),
  refetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  searchResults: { issues: [] as unknown[] },
  deps: {
    view: null as unknown,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/modals", () => ({
  useModalStore: (selector: (s: { open: typeof mocks.openModal }) => unknown) =>
    selector({ open: mocks.openModal }),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));
vi.mock("../navigation", () => ({ useNavigation: () => ({ push: mocks.push }) }));
vi.mock("@multica/core/issues/mutations", () => ({
  useUpdateIssue: () => ({ mutateAsync: mocks.save }),
}));
vi.mock("@multica/core/issues/queries", () => ({
  issueDetailOptions: (_wsId: string, id: string) => ({ queryKey: ["detail", id] }),
  issueDependenciesOptions: (_wsId: string, id: string) => ({ queryKey: ["deps", id] }),
  issueSearchOptions: (_wsId: string, q: string) => ({ queryKey: ["search", q] }),
  issueKeys: {
    dependencies: (_wsId: string, id: string) => ["deps", id],
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: string[]; enabled?: boolean }) => {
    const kind = opts.queryKey[0];
    if (kind === "detail") {
      return { data: { id: "issue-1", identifier: "MUL-1", title: "Target" }, isSuccess: true };
    }
    if (kind === "search") {
      return {
        data: mocks.searchResults,
        isSuccess: true,
        isFetching: false,
      };
    }
    return {
      data: mocks.deps.view,
      isLoading: mocks.deps.isLoading,
      isError: mocks.deps.isError,
      isSuccess: !mocks.deps.isLoading && !mocks.deps.isError,
      refetch: mocks.refetch,
    };
  },
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

// Local mirror of the real dependencyErrorDetails contract (core/api is
// mocked here because api.searchIssues must be stubbed): reason_code gated on
// the dependency_ prefix, body projection passed through.
class TestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}
vi.mock("@multica/core/api", () => ({
  api: { searchIssues: mocks.search },
  clientErrorMessage: (err: unknown) =>
    err instanceof TestApiError && err.status >= 400 && err.status < 500 ? err.message : undefined,
  dependencyErrorDetails: (err: unknown) => {
    if (!(err instanceof TestApiError) || !err.body || typeof err.body !== "object") return null;
    const body = err.body as { reason_code?: unknown; dependencies?: unknown };
    if (typeof body.reason_code !== "string" || !body.reason_code.startsWith("dependency_")) {
      return null;
    }
    return { reasonCode: body.reason_code, dependencies: body.dependencies ?? null };
  },
}));

// The prerequisite rows have their own suite; here a thin list stub exposes
// the add/remove/source actions the editor wires up.
vi.mock("../issues/components/dependency-prerequisites", () => ({
  PrerequisiteList: ({ items, mode, onRemove, onEditSource }: {
    items: {
      issueId: string;
      identifier?: string;
      inheritedFrom: string[];
    }[];
    mode?: string;
    onRemove?: (p: { issueId: string }) => void;
    onEditSource?: (ancestorId: string) => void;
  }) => (
    <div data-testid={`prereq-list-${mode ?? "direct"}`}>
      {items.map((p) => (
        <div key={p.issueId}>
          <span>{p.identifier ?? p.issueId}</span>
          {onRemove && (
            <button type="button" onClick={() => onRemove(p)}>
              remove-{p.identifier ?? p.issueId}
            </button>
          )}
          {onEditSource && (
            <button type="button" onClick={() => onEditSource(p.inheritedFrom[0]!)}>
              source-{p.issueId}
            </button>
          )}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("../issues/components/status-icon", () => ({ StatusIcon: () => null }));

vi.mock("@multica/ui/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
vi.mock("@multica/ui/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("@multica/ui/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@multica/ui/components/ui/command", () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: ({ value, onValueChange, placeholder }: {
    value: string;
    onValueChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, onSelect, disabled }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("../i18n", () => ({
  useT: () => ({
    t: (
      sel: (x: Record<string, Record<string, string>>) => string,
      vars?: Record<string, unknown>,
    ) => {
      const labels = {
        edit_dependencies: {
          title: "Edit prerequisites",
          description: "desc",
          description_for: `for ${String(vars?.identifier ?? "")}`,
          direct_section: "Direct prerequisites",
          empty_direct: "No direct prerequisites",
          inherited_section: "Inherited prerequisites",
          inherited_hint: "hint",
          restricted_note: "restricted",
          self_badge: "This issue",
          added_badge: "Added",
          inherited_badge: "Inherited",
          conflict_notice: "conflict refresh",
          error_structure: "cycle error",
          error_permission: "permission error",
          error_unverified: "unverified",
          error_generic: "save failed",
          unknown_state: "unknown state",
          load_error: "load error",
          retry: "Retry",
          cancel: "Cancel",
          save: "Save",
          toast_saved: "saved",
        },
        issue_picker: {
          search_placeholder: "Search issues",
          searching: "Searching",
          no_results: "No results",
          prompt_to_search: "Type to search",
        },
      };
      return sel(labels as never);
    },
  }),
}));

const prereq = (
  id: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
) => ({
  issueId: id,
  status: "in_progress",
  statusCategory: "in_progress",
  satisfied: false,
  sourceEdges: ["edge-1"],
  inheritedFrom: [],
  title: identifier,
  identifier,
  descendantCount: 0,
  ...overrides,
});

const view = (overrides: Record<string, unknown> = {}) => ({
  blockedBy: [prereq("issue-9", "MUL-9")],
  inheritedBlockedBy: [],
  blocking: [],
  unsatisfied: [],
  hasRestrictedBlockers: false,
  dependencyVersion: "v1",
  ...overrides,
});

describe("EditDependenciesModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deps.view = view();
    mocks.deps.isLoading = false;
    mocks.deps.isError = false;
    mocks.save.mockResolvedValue({ id: "issue-1" });
    mocks.search.mockResolvedValue({ issues: [] });
    mocks.searchResults = { issues: [] };
    mocks.refetch.mockResolvedValue({ data: mocks.deps.view });
  });

  it("adds a searched issue and saves the full replacement set with the reviewed version", async () => {
    mocks.searchResults = {
      issues: [
        {
          id: "issue-7",
          identifier: "MUL-7",
          title: "Found",
          status: "todo",
          status_category: "todo",
        },
      ],
    };
    const onClose = vi.fn();
    render(<EditDependenciesModal onClose={onClose} data={{ issueId: "issue-1" }} />);

    // Current direct prerequisite hydrated from the projection.
    expect(screen.getByTestId("prereq-list-direct")).toHaveTextContent("MUL-9");

    fireEvent.change(screen.getByPlaceholderText("Search issues"), { target: { value: "found" } });
    const pick = await screen.findByRole("button", { name: /MUL-7/ });
    fireEvent.click(pick);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith({
      id: "issue-1",
      blockedBy: ["issue-7", "issue-9"],
      expectedDependencyVersion: "v1",
    });
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("saved"));
    expect(onClose).toHaveBeenCalled();
  });

  it("removes a direct prerequisite and saves the reduced set", async () => {
    render(<EditDependenciesModal onClose={vi.fn()} data={{ issueId: "issue-1" }} />);
    fireEvent.click(screen.getByRole("button", { name: "remove-MUL-9" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        id: "issue-1",
        blockedBy: [],
        expectedDependencyVersion: "v1",
      }),
    );
  });

  it("keeps the dialog open and the save disabled while nothing changed", () => {
    render(<EditDependenciesModal onClose={vi.fn()} data={{ issueId: "issue-1" }} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("REVIEW preserves a concurrently added prerequisite when retrying the user removal", async () => {
    // The server refused v1 and attached the current (v2) projection.
    mocks.save.mockRejectedValueOnce(
      new TestApiError("conflict", 409, {
        error: "version conflict",
        reason_code: "dependency_version_conflict",
        dependencies: view({
          blockedBy: [prereq("issue-8", "MUL-8")],
          dependencyVersion: "v2",
        }),
      }),
    );
    render(<EditDependenciesModal onClose={vi.fn()} data={{ issueId: "issue-1" }} />);

    // User removes MUL-9, saves, conflicts.
    fireEvent.click(screen.getByRole("button", { name: "remove-MUL-9" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("conflict refresh"));

    // The user's removal survives the re-base; the retry carries the fresh version.
    expect(mocks.setQueryData).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenLastCalledWith({
        id: "issue-1",
        blockedBy: ["issue-8"],
        expectedDependencyVersion: "v2",
      }),
    );
  });

  it("explains a structural rejection and never closes the dialog", async () => {
    const onClose = vi.fn();
    mocks.save.mockRejectedValueOnce(
      new TestApiError("cycle", 409, {
        error: "cycle",
        reason_code: "dependency_cycle",
      }),
    );
    render(<EditDependenciesModal onClose={onClose} data={{ issueId: "issue-1" }} />);

    fireEvent.click(screen.getByRole("button", { name: "remove-MUL-9" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cycle error"));
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("explains the permission refusal when removing an unfinished prerequisite", async () => {
    mocks.save.mockRejectedValueOnce(
      new TestApiError("forbidden", 403, {
        error: "not allowed",
        reason_code: "dependency_change_not_allowed",
      }),
    );
    render(<EditDependenciesModal onClose={vi.fn()} data={{ issueId: "issue-1" }} />);

    fireEvent.click(screen.getByRole("button", { name: "remove-MUL-9" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("permission error"));
  });

  it("lists inherited prerequisites read-only and jumps to the source editor", () => {
    mocks.deps.view = view({
      inheritedBlockedBy: [
        prereq("issue-5", "MUL-5", { inheritedFrom: ["ancestor-3"] }),
      ],
    });
    render(<EditDependenciesModal onClose={vi.fn()} data={{ issueId: "issue-1" }} />);

    const inheritedList = screen.getByTestId("prereq-list-inherited");
    expect(inheritedList).toHaveTextContent("MUL-5");
    // No removal on inherited rows — only the source jump.
    expect(screen.queryByRole("button", { name: "remove-MUL-5" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "source-issue-5" }));
    expect(mocks.openModal).toHaveBeenCalledWith("issue-edit-dependencies", {
      issueId: "ancestor-3",
    });
  });

  it("treats a malformed projection as unknown and blocks saving", () => {
    mocks.deps.view = null;
    render(<EditDependenciesModal onClose={vi.fn()} data={{ issueId: "issue-1" }} />);
    expect(screen.getByText("unknown state")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
