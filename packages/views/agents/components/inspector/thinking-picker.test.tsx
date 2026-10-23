// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { RuntimeModelThinkingLevel } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enAgents from "../../../locales/en/agents.json";
import enIssues from "../../../locales/en/issues.json";
import enForkUi from "../../../locales/en/fork-ui.json";
import enQuota from "../../../locales/en/quota.json";
import { renderWithI18n } from "../../../test/i18n";

import { ThinkingPicker } from "./thinking-picker";

const TEST_RESOURCES = {
  en: {
    common: enCommon,
    agents: enAgents,
    issues: enIssues,
    "fork-ui": enForkUi,
    quota: enQuota,
  },
};

const CODEX_LEVELS: RuntimeModelThinkingLevel[] = [
  { value: "minimal", label: "Minimal", description: "Fast, light reasoning" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function renderPicker(props: Partial<React.ComponentProps<typeof ThinkingPicker>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ThinkingPicker
        value=""
        levels={CODEX_LEVELS}
        canEdit
        onChange={onChange}
        {...props}
      />
    </I18nProvider>,
  );
  return { ...utils, onChange };
}

describe("ThinkingPicker", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders "Follow CLI config" when value is empty', () => {
    renderPicker({ value: "" });
    // The trigger and the tooltip both carry the label. Empty value means
    // Multica omits --effort, so the local CLI's config decides the
    // reasoning level — see thinking-prop-row.tsx for the contract.
    expect(screen.getAllByText("Follow CLI config").length).toBeGreaterThan(0);
  });

  it("renders the matching level label when value is set", () => {
    renderPicker({ value: "high" });
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
  });

  it("renders the raw token when the saved value is no longer in the catalog", () => {
    // Simulates a model swap that dropped the option the user previously
    // picked — we still surface what's persisted so the user can clear it,
    // rather than silently showing "Follow CLI config".
    renderPicker({ value: "xhigh", levels: CODEX_LEVELS });
    expect(screen.getAllByText("xhigh").length).toBeGreaterThan(0);
  });

  it("renders a static read-only display when canEdit=false and exposes no popover trigger", () => {
    renderPicker({ value: "low", canEdit: false });
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("calls onChange with the picked value and skips when the user re-picks the current value", () => {
    const { onChange } = renderPicker({ value: "low" });
    fireEvent.click(screen.getByRole("button"));

    // Picking a new level fires onChange with the runtime-native value.
    fireEvent.click(screen.getByText("High"));
    expect(onChange).toHaveBeenCalledWith("high");

    // Re-opening and clicking the already-selected value is a no-op so we
    // don't enqueue a redundant PATCH. The trigger also reads "Low", so
    // there are two matches in the DOM — target the listbox item by
    // selecting the option button explicitly.
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button"));
    const lowOption = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-picker-item") !== null && b.textContent?.includes("Low"));
    expect(lowOption).toBeDefined();
    fireEvent.click(lowOption!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears to empty string via the footer button when a value is set", () => {
    const { onChange } = renderPicker({ value: "high" });
    fireEvent.click(screen.getByRole("button"));
    // Footer copy resolves through i18n — match a substring so we don't
    // pin to the exact translated wording.
    const clearButton = screen.getByTitle(/Clear the override/i);
    fireEvent.click(clearButton);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("does not render the clear button when value is already empty", () => {
    renderPicker({ value: "" });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTitle(/Clear and fall back/i)).toBeNull();
  });

  it("offers Adapt at the top when at least two candidates remain", () => {
    renderPicker({ adaptSupported: true });
    fireEvent.click(screen.getByRole("button"));

    const items = document.querySelectorAll("button[data-picker-item]");
    expect(items[0]).toHaveTextContent("Adapt");
    // The disclosure names possible destinations without pinning a default,
    // since the daemon's MULTICA_JEV_SOURCES decides what actually runs.
    expect(
      screen.getByText(
        /run summary including raw tool output is sent to an external decision service configured on this machine, such as OpenCode Zen or Alibaba Cloud Model Studio/,
      ),
    ).toBeInTheDocument();
  });

  it("omits Adapt when fewer than two candidates remain", () => {
    renderPicker({
      levels: [
        { value: "auto", label: "Auto" },
        { value: "off", label: "Off" },
        { value: "high", label: "High" },
      ],
    });
    fireEvent.click(screen.getByRole("button"));

    expect(screen.queryByText("Adapt")).not.toBeInTheDocument();
    expect(screen.getByText("Auto")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("disables Adapt and explains the required daemon upgrade without the capability", () => {
    renderPicker({ adaptSupported: false });
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Adapt").closest("button")).toBeDisabled();
    expect(screen.getByText(/daemon is too old for Adapt/)).toBeInTheDocument();
  });

  it("submits the reserved Adapt value", () => {
    const { onChange } = renderPicker({ adaptSupported: true });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Adapt"));

    expect(onChange).toHaveBeenCalledWith("_adapt");
  });

  it("shows Adapt instead of its reserved value in read-only mode", () => {
    renderPicker({ value: "_adapt", canEdit: false });

    expect(screen.getByText("Adapt")).toBeInTheDocument();
    expect(screen.queryByText("_adapt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a runtime-native Auto level distinct from Adapt", () => {
    renderPicker({
      value: "auto",
      adaptSupported: true,
      levels: [
        { value: "auto", label: "Auto" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
    });
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getAllByText("Auto").length).toBeGreaterThan(0);
    expect(screen.getByText("Adapt")).toBeInTheDocument();
    expect(screen.queryByText("_adapt")).not.toBeInTheDocument();
  });

  it.each([
    ["opencode", "OpenCode Zen"],
    ["opencode-free", "OpenCode Zen (free)"],
    ["dashscope", "Alibaba Cloud Model Studio"],
    ["self-hosted", "Self-hosted"],
    ["decision.internal", "decision.internal"],
  ])("shows the %s decision source in the subtitle", (source, label) => {
    renderPicker({
      adaptSupported: true,
      adaptSnapshot: {
        status: "available",
        active_source: source,
        last_latency_ms: 290,
        decisions_ok: 12,
        decisions_fallback: 3,
        since: "2026-10-21T00:00:00Z",
        updated_at: "2026-10-21T01:00:00Z",
      },
    });
    fireEvent.click(screen.getByRole("button"));

    expect(
      screen.getByText(`Available · ${label} · 290ms`),
    ).toBeInTheDocument();
  });

  it.each([
    ["opencode", "OpenCode Zen"],
    ["opencode-free", "OpenCode Zen 免费通道"],
    ["dashscope", "阿里云百炼"],
    ["self-hosted", "自部署"],
  ])("shows the %s decision source in the zh-Hans subtitle", (source, label) => {
    // TEST_RESOURCES above is en-only; the zh-Hans column goes through the
    // shared renderWithI18n helper, which wraps the production RESOURCES.
    renderWithI18n(
      <ThinkingPicker
        value=""
        levels={CODEX_LEVELS}
        canEdit
        adaptSupported
        adaptSnapshot={{
          status: "available",
          active_source: source,
          last_latency_ms: 290,
          decisions_ok: 12,
          decisions_fallback: 3,
          since: "2026-10-21T00:00:00Z",
          updated_at: "2026-10-21T01:00:00Z",
        }}
        onChange={vi.fn()}
      />,
      { locale: "zh-Hans" },
    );
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText(`可用 · ${label} · 290ms`)).toBeInTheDocument();
  });

  it("shows the zh-Hans disclosure naming the possible destinations", () => {
    renderWithI18n(
      <ThinkingPicker
        value=""
        levels={CODEX_LEVELS}
        canEdit
        adaptSupported
        onChange={vi.fn()}
      />,
      { locale: "zh-Hans" },
    );
    fireEvent.click(screen.getByRole("button"));

    expect(
      screen.getByText(
        "选中后，会将运行摘要（包括工具输出原文）发送给本机配置的外部决策服务，例如 OpenCode Zen、阿里云百炼。",
      ),
    ).toBeInTheDocument();
  });

  it("uses a neutral status when no snapshot is available", () => {
    renderPicker({ adaptSupported: true, adaptSnapshot: null });
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Status unknown")).toBeInTheDocument();
  });
});
