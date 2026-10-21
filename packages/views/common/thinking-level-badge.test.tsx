import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TaskMessagePayload,
  TaskMessageThinkingMetadata,
} from "@multica/core/types/events";
import { renderWithI18n } from "../test/i18n";
import {
  ThinkingLevelBadge,
  ThinkingRunSummaryBadge,
  thinkingSourceDisplayName,
} from "./thinking-level-badge";

function message(
  seq: number,
  thinking?: TaskMessageThinkingMetadata,
  type: TaskMessagePayload["type"] = "thinking",
): TaskMessagePayload {
  return {
    task_id: "task",
    issue_id: "issue",
    seq,
    type,
    metadata: thinking ? { thinking } : undefined,
  };
}

const adapt = (
  level: string,
  step: number,
  extra: Partial<TaskMessageThinkingMetadata> = {},
): TaskMessageThinkingMetadata => ({ level, mode: "adapt", step, ...extra });

function chip(label: string | RegExp) {
  return screen.getByText(label).closest<HTMLElement>('[data-slot="tooltip-trigger"]')!;
}

async function tooltipOf(label: string | RegExp) {
  await userEvent.hover(chip(label));
  const content = await screen.findByText((_, node) =>
    node?.getAttribute?.("data-slot") === "tooltip-content" &&
    (node.textContent?.length ?? 0) > 0,
  );
  return content;
}

afterEach(cleanup);

describe("ThinkingLevelBadge", () => {
  it("renders nothing for runs without metadata", () => {
    const { container } = renderWithI18n(<ThinkingLevelBadge messages={[message(1), message(2)]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the latest level with an up arrow after a raise", () => {
    renderWithI18n(
      <ThinkingLevelBadge messages={[message(1, adapt("low", 1)), message(2, adapt("xhigh", 2))]} />,
    );
    expect(chip("xhigh")).toHaveTextContent("↑");
  });

  it("shows a down arrow after a drop, including while a tool runs", () => {
    renderWithI18n(
      <ThinkingLevelBadge
        messages={[
          message(1, adapt("xhigh", 1)),
          message(2, adapt("low", 2), "tool_use"),
        ]}
      />,
    );
    expect(chip("low")).toHaveTextContent("↓");
  });

  it("shows no arrow when the level held or cannot be ordered", () => {
    const { rerender } = renderWithI18n(
      <ThinkingLevelBadge messages={[message(1, adapt("high", 1)), message(2, adapt("high", 2))]} />,
    );
    expect(chip("high")).not.toHaveTextContent("↑");
    expect(chip("high")).not.toHaveTextContent("↓");
    rerender(
      <ThinkingLevelBadge messages={[message(1, adapt("custom-variant", 1)), message(2, adapt("high", 2))]} />,
    );
    expect(chip("high")).not.toHaveTextContent("↑");
  });

  it("renders the fallback state as the default level with its reason on hover", async () => {
    renderWithI18n(
      <ThinkingLevelBadge messages={[message(1, adapt("high", 1)), message(2, adapt("", 2, { fallback: "timeout" }))]} />,
    );
    const tooltip = await tooltipOf("Default");
    expect(tooltip).toHaveTextContent("Fell back to the default level: timed out");
  });

  it("shows a fixed level without an arrow and explains it on hover", async () => {
    renderWithI18n(
      <ThinkingLevelBadge
        messages={[message(1, { level: "low", mode: "fixed", step: 1 }), message(2, { level: "xhigh", mode: "fixed", step: 2 })]}
      />,
    );
    expect(chip("xhigh")).not.toHaveTextContent("↑");
    const tooltip = await tooltipOf("xhigh");
    expect(tooltip).toHaveTextContent("Fixed level");
  });

  it("details the decision on hover: level, confidence, latency, source, probabilities", async () => {
    renderWithI18n(
      <ThinkingLevelBadge
        messages={[message(1, adapt("xhigh", 1, {
          source: "opencode-free",
          confidence: 0.88,
          latency_ms: 284,
          probabilities: { high: 0.12, xhigh: 0.88 },
        }))]}
      />,
    );
    const tooltip = await tooltipOf("xhigh");
    expect(tooltip).toHaveTextContent("Jev dynamic decision: xhigh");
    expect(tooltip).toHaveTextContent("confidence 88%");
    expect(tooltip).toHaveTextContent("284 ms");
    expect(tooltip).toHaveTextContent("source: OpenCode Zen");
    expect(tooltip).toHaveTextContent("Probability distribution");
    expect(tooltip).toHaveTextContent("xhigh 88%");
    expect(tooltip).toHaveTextContent("high 12%");
  });

  it("localizes the self-hosted source name", async () => {
    renderWithI18n(
      <ThinkingLevelBadge messages={[message(1, adapt("high", 1, { source: "self-hosted" }))]} />,
    );
    const tooltip = await tooltipOf("high");
    expect(tooltip).toHaveTextContent("source: Self-hosted");
  });

  it("shows an unrecognized source name as-is", async () => {
    renderWithI18n(
      <ThinkingLevelBadge messages={[message(1, adapt("high", 1, { source: "acme-decider" }))]} />,
    );
    const tooltip = await tooltipOf("high");
    expect(tooltip).toHaveTextContent("source: acme-decider");
  });
});

describe("ThinkingRunSummaryBadge", () => {
  it("renders nothing for runs without metadata", () => {
    const { container } = renderWithI18n(<ThinkingRunSummaryBadge messages={[message(1)]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("summarizes an adaptive run with its decision count and peak", async () => {
    renderWithI18n(
      <ThinkingRunSummaryBadge
        messages={[
          message(1, adapt("low", 1)),
          message(2, adapt("low", 1)),
          message(3, adapt("xhigh", 2)),
          message(4, adapt("", 3, { fallback: "breaker" })),
        ]}
      />,
    );
    expect(screen.getByText("Adapt · 2 decisions · peak xhigh")).toBeInTheDocument();
    const tooltip = await tooltipOf("Adapt · 2 decisions · peak xhigh");
    expect(tooltip).toHaveTextContent("#1 low");
    expect(tooltip).toHaveTextContent("#2 xhigh");
    expect(tooltip).toHaveTextContent("#3 default · breaker open");
    expect(tooltip).toHaveTextContent("1 fallback");
  });

  it("summarizes a fixed run", () => {
    renderWithI18n(
      <ThinkingRunSummaryBadge messages={[message(1, { level: "ultra", mode: "fixed", step: 1 })]} />,
    );
    expect(screen.getByText("Fixed · ultra")).toBeInTheDocument();
  });
});

describe("thinkingSourceDisplayName", () => {
  it("maps the named sources and passes the rest through", () => {
    expect(thinkingSourceDisplayName("self-hosted", "Self-hosted")).toBe("Self-hosted");
    expect(thinkingSourceDisplayName("opencode-free", "x")).toBe("OpenCode Zen");
    expect(thinkingSourceDisplayName("opencode", "x")).toBe("OpenCode Zen");
    expect(thinkingSourceDisplayName("dashscope", "x")).toBe("dashscope");
  });
});
