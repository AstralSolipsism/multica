// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Issue } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { DagAssignAction, useDagIssueSelection } from "./dag-issue-actions";

const queryState = vi.hoisted(() => ({
  current: { data: null as unknown, isError: false, refetch: vi.fn() },
}));
const useQuerySpy = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: (options: unknown) => {
    useQuerySpy(options);
    return queryState.current;
  },
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

const useIssueActionsSpy = vi.hoisted(() => vi.fn());
vi.mock("../actions/use-issue-actions", () => ({
  useIssueActions: (issue: unknown) => useIssueActionsSpy(issue),
}));

const pickerSpy = vi.hoisted(() => vi.fn<(props: Record<string, unknown>) => void>());
vi.mock("../components/pickers/assignee-picker", () => ({
  AssigneePicker: (props: Record<string, unknown>) => {
    pickerSpy(props);
    return <button data-testid="assignee-picker" />;
  },
}));

function HookProbe({ issueId }: { issueId: string | null }) {
  const result = useDagIssueSelection(issueId);
  return (
    <output
      data-testid="probe"
      data-issue={result.issue ? (result.issue as Issue).id : ""}
      data-failed={String(result.detailFailed)}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  queryState.current = { data: null, isError: false, refetch: vi.fn() };
});

describe("useDagIssueSelection", () => {
  it("stays unsubscribed for a null issue id", () => {
    render(<HookProbe issueId={null} />);
    expect(useQuerySpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByTestId("probe")).toHaveAttribute("data-issue", "");
    expect(screen.getByTestId("probe")).toHaveAttribute("data-failed", "false");
  });

  it("subscribes to the detail and forwards the issue to the actions hook", () => {
    const issue = { id: "i-1" } as Issue;
    queryState.current.data = issue;
    render(<HookProbe issueId="i-1" />);
    expect(useQuerySpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByTestId("probe")).toHaveAttribute("data-issue", "i-1");
    expect(useIssueActionsSpy).toHaveBeenCalledWith(issue);
  });

  it("reports a failed detail fetch and retries on demand", () => {
    const refetch = vi.fn();
    queryState.current = { data: null, isError: true, refetch };
    render(<HookProbe issueId="i-2" />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-failed", "true");
  });
});

describe("DagAssignAction", () => {
  const issue = { id: "i-1", assignee_type: null, assignee_id: null } as Issue;

  it("renders a disabled placeholder while the detail loads", () => {
    renderWithI18n(<DagAssignAction issue={null} onUpdate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
  });

  it("mounts the picker with its visible trigger once the issue is known", () => {
    renderWithI18n(<DagAssignAction issue={issue} onUpdate={vi.fn()} />);
    const props = pickerSpy.mock.calls.at(-1)![0];
    expect(props).toMatchObject({ assigneeType: null, assigneeId: null });
    expect(props).not.toHaveProperty("open");
    expect(props.triggerRender).toBeTruthy();
  });

  it("forwards controlled open state and the menu anchor to the picker", () => {
    const anchor = <span data-testid="anchor" />;
    const onOpenChange = vi.fn();
    renderWithI18n(
      <DagAssignAction
        issue={issue}
        onUpdate={vi.fn()}
        open
        onOpenChange={onOpenChange}
        anchor={anchor}
      />,
    );
    expect(pickerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ open: true, onOpenChange, triggerRender: anchor }),
    );
  });
});
