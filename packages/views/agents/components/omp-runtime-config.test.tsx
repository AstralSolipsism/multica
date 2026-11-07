// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { OmpRuntimeConfig } from "@multica/core/agents";
import { renderWithI18n } from "../../test/i18n";

vi.mock("./inspector/model-picker", () => ({
  ModelPicker: ({
    ariaLabel,
    value,
    placeholder,
    invalid,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    placeholder: string;
    invalid: boolean;
    onChange: (value: string) => void;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onClick={() => onChange("zai/glm-5.3")}
    >
      {value || placeholder}
    </button>
  ),
}));

import {
  OmpRuntimeConfigPanel,
  OmpRuntimeConfigSummary,
} from "./omp-runtime-config";

function renderPanel({
  provider = "omp",
  value = {},
  mainModel = "openai-codex/gpt-6.1-sol",
  onChange = vi.fn(),
}: {
  provider?: string;
  value?: OmpRuntimeConfig;
  mainModel?: string;
  onChange?: (next: OmpRuntimeConfig) => void;
} = {}) {
  renderWithI18n(
    <OmpRuntimeConfigPanel
      provider={provider}
      runtimeId="runtime-omp"
      runtimeOnline
      mainModel={mainModel}
      value={value}
      canEdit
      onChange={onChange}
    />,
  );
  return { onChange };
}

afterEach(cleanup);

describe("OmpRuntimeConfigPanel", () => {
  it("renders exactly the four configuration groups for OMP", () => {
    renderPanel();

    expect(screen.getByText("Model roles")).toBeInTheDocument();
    expect(screen.getByText("Advisor reviewer")).toBeInTheDocument();
    expect(screen.getByText("Execution mode")).toBeInTheDocument();
    expect(screen.getByText("Memory & auto-learn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan model (optional)" })).toBeNull();
  });

  it("renders nothing for a non-OMP runtime", () => {
    renderPanel({ provider: "codex" });

    expect(screen.queryByTestId("omp-runtime-config")).toBeNull();
  });

  it("defaults Advisor review to agent-end when enabled", () => {
    const { onChange } = renderPanel();

    expect(screen.queryByRole("button", { name: "Slow / Advisor model" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Advisor" }));

    expect(onChange).toHaveBeenCalledWith({
      advisorEnabled: true,
      advisorReviewMode: "agent-end",
    });
  });

  it("shows Advisor controls and updates the review cadence", () => {
    const { onChange } = renderPanel({
      value: { advisorEnabled: true, advisorReviewMode: "agent-end" },
    });

    expect(screen.getByRole("button", { name: "Slow / Advisor model" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Before delivery/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Every turn/ }));

    expect(onChange).toHaveBeenCalledWith({
      advisorEnabled: true,
      advisorReviewMode: "turn",
    });
  });

  it("reveals Plan and Handoff only for a collaborative execution mode", () => {
    const { onChange } = renderPanel({
      value: { executionMode: "plan_yolo", handoffModel: "zai/glm-5.3" },
    });

    expect(screen.getByRole("button", { name: "Plan model (optional)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Handoff model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^Standard/ }));

    expect(onChange).toHaveBeenCalledWith({
      executionMode: "standard",
      handoffModel: "zai/glm-5.3",
    });
  });

  it.each(["plan_yolo", "prewalk"] as const)(
    "requires a handoff model in %s mode",
    (executionMode) => {
      const { onChange } = renderPanel({ value: { executionMode } });
      const handoff = screen.getByRole("button", { name: "Handoff model" });

      expect(handoff).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Select a handoff model for this execution mode.",
      );
      fireEvent.click(handoff);
      expect(onChange).toHaveBeenCalledWith({
        executionMode,
        handoffModel: "zai/glm-5.3",
      });
    },
  );

  it("warns without blocking when Advisor or Handoff duplicates the main model", () => {
    const mainModel = "openai-codex/gpt-6.1-sol";
    renderPanel({
      mainModel,
      value: {
        advisorEnabled: true,
        slowModel: mainModel,
        executionMode: "plan_yolo",
        handoffModel: mainModel,
      },
    });

    expect(screen.getAllByRole("note")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("switches the memory backend and normalizes off away", () => {
    const { onChange } = renderPanel();

    expect(screen.getByRole("radio", { name: /^Off/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Sharpshooter/ }));

    expect(onChange).toHaveBeenCalledWith({ memoryBackend: "sharpshooter" });
  });

  it("normalizes a selected memory backend back to off", () => {
    const { onChange } = renderPanel({ value: { memoryBackend: "mnemopi" } });

    fireEvent.click(screen.getByRole("radio", { name: /^Off/ }));

    expect(onChange).toHaveBeenCalledWith({ memoryBackend: undefined });
  });

  it("enables auto-learn from the switch", () => {
    const { onChange } = renderPanel();

    fireEvent.click(screen.getByRole("switch", { name: "Auto-learn managed skills" }));

    expect(onChange).toHaveBeenCalledWith({ autolearnEnabled: true });
  });

  it("normalizes a disabled auto-learn switch away", () => {
    const { onChange } = renderPanel({ value: { autolearnEnabled: true } });

    fireEvent.click(screen.getByRole("switch", { name: "Auto-learn managed skills" }));

    expect(onChange).toHaveBeenCalledWith({ autolearnEnabled: undefined });
  });
});

describe("OmpRuntimeConfigSummary", () => {
  it("renders only active strategy chips", () => {
    renderWithI18n(
      <OmpRuntimeConfigSummary
        config={{
          smolModel: "zai/glm-5.3-flash",
          advisorEnabled: true,
          slowModel: "openai-codex/gpt-6-astra",
          advisorReviewMode: "agent-end",
          executionMode: "prewalk",
          planModel: "openai-codex/gpt-6.1-sol",
          handoffModel: "kimi-code/k2.5",
        }}
      />,
    );

    for (const label of [
      "Smol: glm-5.3-flash",
      "Advisor: gpt-6-astra · Before delivery",
      "Prewalk → k2.5",
      "Plan: gpt-6.1-sol",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders memory and auto-learn chips when enabled", () => {
    const { rerender } = renderWithI18n(
      <OmpRuntimeConfigSummary
        config={{ memoryBackend: "mnemopi", autolearnEnabled: true }}
      />,
    );

    expect(screen.getByText("Memory: Mnemopi")).toBeInTheDocument();
    expect(screen.getByText("Auto-Learn: On")).toBeInTheDocument();

    rerender(
      <OmpRuntimeConfigSummary
        config={{ memoryBackend: "sharpshooter", autolearnEnabled: false }}
      />,
    );
    expect(screen.getByText("Memory: Sharpshooter")).toBeInTheDocument();
    expect(screen.queryByText(/Auto-Learn/)).toBeNull();
  });

  it("omits inactive roles and renders the empty state", () => {
    const { rerender } = renderWithI18n(
      <OmpRuntimeConfigSummary
        config={{
          slowModel: "openai-codex/gpt-6-astra",
          planModel: "openai-codex/gpt-6.1-sol",
          handoffModel: "zai/glm-5.3",
        }}
      />,
    );

    expect(screen.getByText("No collaboration strategies enabled")).toBeInTheDocument();
    expect(screen.queryByText(/Advisor:/)).toBeNull();
    expect(screen.queryByText(/Prewalk/)).toBeNull();

    rerender(
      <OmpRuntimeConfigSummary
        config={{ advisorEnabled: true, advisorReviewMode: "turn" }}
      />,
    );
    expect(screen.getByText("Advisor: Auto-select · Every turn")).toBeInTheDocument();
  });
});
