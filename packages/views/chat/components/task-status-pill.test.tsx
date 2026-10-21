import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskMessagePayload } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { TaskStatusPill } from "./task-status-pill";

function tagged(
  seq: number,
  level: string,
  step: number,
  mode: "adapt" | "fixed" = "adapt",
): TaskMessagePayload {
  return {
    task_id: "task",
    issue_id: "",
    seq,
    type: "thinking",
    metadata: { thinking: { level, mode, step } },
  };
}

function renderPill(taskMessages: TaskMessagePayload[]) {
  return renderWithI18n(
    <TaskStatusPill
      pendingTask={{ task_id: "task", status: "running", created_at: "2026-10-21T00:00:00Z" }}
      taskMessages={taskMessages}
      availability={undefined}
    />,
  );
}

afterEach(cleanup);

describe("TaskStatusPill thinking-level badge", () => {
  it("shows the current level between the stage label and the elapsed time", () => {
    const { container } = renderPill([tagged(1, "xhigh", 1)]);
    expect(screen.getByText("xhigh")).toBeInTheDocument();
    expect(container.textContent).toContain("Thinking · xhigh · ");
  });

  it("marks raises and drops against the previous step", () => {
    const { rerender } = renderPill([tagged(1, "low", 1), tagged(2, "xhigh", 2)]);
    expect(screen.getByText("xhigh")).toHaveTextContent("↑");
    rerender(
      <TaskStatusPill
        pendingTask={{ task_id: "task", status: "running", created_at: "2026-10-21T00:00:00Z" }}
        taskMessages={[tagged(1, "xhigh", 1), tagged(2, "low", 2)]}
        availability={undefined}
      />,
    );
    expect(screen.getByText("low")).toHaveTextContent("↓");
  });

  it("shows the fallback state as the default level", () => {
    renderPill([
      tagged(1, "high", 1),
      {
        task_id: "task",
        issue_id: "",
        seq: 2,
        type: "thinking",
        metadata: { thinking: { level: "", mode: "adapt", step: 2, fallback: "disabled" } },
      },
    ]);
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("shows a fixed level without an arrow", () => {
    renderPill([tagged(1, "low", 1, "fixed"), tagged(2, "ultra", 2, "fixed")]);
    const chip = screen.getByText("ultra");
    expect(chip).not.toHaveTextContent("↑");
    expect(chip).not.toHaveTextContent("↓");
  });

  it("renders no badge for streams without metadata", () => {
    const { container } = renderPill([
      { task_id: "task", issue_id: "", seq: 1, type: "thinking", content: "planning" },
    ]);
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
    expect(container.textContent).toContain("Thinking · ");
    expect(container.textContent).not.toContain("Thinking · ·");
  });
});
