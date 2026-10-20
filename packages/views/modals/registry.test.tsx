import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useModalStore } from "@multica/core/modals";
import { ModalRegistry } from "./registry";

vi.mock("./create-issue-dialog", () => ({ CreateIssueDialog: () => null }));
vi.mock("./create-project", () => ({ CreateProjectModal: () => null }));
vi.mock("./create-squad", () => ({ CreateSquadModal: () => null }));
vi.mock("./feedback", () => ({ FeedbackModal: () => null }));
vi.mock("./set-parent-issue", () => ({ SetParentIssueModal: () => null }));
vi.mock("./mark-duplicate-issue", () => ({ MarkDuplicateIssueModal: () => null }));
vi.mock("./add-child-issue", () => ({ AddChildIssueModal: () => null }));
vi.mock("./delete-issue-confirm", () => ({ DeleteIssueConfirmModal: () => null }));
vi.mock("./issue-limit-upgrade-dialog", () => ({ IssueLimitUpgradeDialog: () => null }));
vi.mock("./run-confirm", () => ({
  RunConfirmModal: () => <div role="dialog" aria-label="Run confirmation" />,
}));
vi.mock("./edit-dependencies", () => ({
  EditDependenciesModal: ({ onClose, data }: { onClose: () => void; data: Record<string, unknown> }) => (
    <div role="dialog" aria-label="Dependencies">
      {String(data.issueId)}
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));
vi.mock("./workflow-handoff", () => ({
  WorkflowHandoffModal: () => <div role="dialog" aria-label="Workflow handoff" />,
}));

afterEach(() => useModalStore.getState().close());

it("keeps dependency editing separate from adjacent run and workflow dialogs", () => {
  useModalStore.getState().open("issue-edit-dependencies", { issueId: "issue-1" });
  render(<ModalRegistry />);
  expect(screen.getByRole("dialog", { name: "Dependencies" })).toHaveTextContent("issue-1");
  expect(screen.queryByRole("dialog", { name: "Run confirmation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Workflow handoff" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  act(() => useModalStore.getState().open("issue-workflow-handoff"));
  expect(screen.getByRole("dialog", { name: "Workflow handoff" })).toBeInTheDocument();
  act(() => useModalStore.getState().open("issue-run-confirm"));
  expect(screen.getByRole("dialog", { name: "Run confirmation" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Workflow handoff" })).not.toBeInTheDocument();
});
