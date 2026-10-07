// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRuntime } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { buildRuntimeMachines } from "./runtime-machines";
import { MachineQuotaChips } from "./machine-quota-chips";
import { MiniMeterBar, RuntimeQuotaCard, RuntimeQuotaCell, TONE_BAR_CLASS } from "./runtime-quota-cell";

const NOW_SEC = 1_800_000_000;
const NOW = NOW_SEC * 1000;

afterEach(() => vi.restoreAllMocks());

function quotaRuntime(allReset = false): AgentRuntime {
  return {
    id: "runtime-1", workspace_id: "workspace-1", daemon_id: "daemon-1",
    name: "Antigravity (dev.local)", provider: "antigravity", runtime_mode: "local",
    status: "online", owner_id: "user-1", visibility: "private", device_info: "",
    metadata: {}, launch_header: "", last_seen_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    plan_quota: {
      provider: "antigravity", status: "limited", source: "daemon", observed_at: NOW_SEC - 60,
      windows: [
        { name: "", group: "gemini", used_percent: 100, window_minutes: 300, resets_at: NOW_SEC },
        { name: "", group: "claude_gpt", used_percent: 25, window_minutes: 10080, resets_at: allReset ? NOW_SEC - 1 : NOW_SEC + 86400 },
      ],
    },
  };
}

describe("quota displays after reset", () => {
  it.each([RuntimeQuotaCell, RuntimeQuotaCard])("keeps both groups and hides the reset balance in %s", (Component) => {
    renderWithI18n(<Component runtime={quotaRuntime()} now={NOW} />);
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("Claude + GPT")).toBeInTheDocument();
    expect(screen.getByText("Reset, awaiting refresh")).toBeInTheDocument();
    expect(screen.queryByText(/^0%/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it.each([RuntimeQuotaCell, RuntimeQuotaCard])("does not call a fully reset snapshot unreported or exhausted in %s", (Component) => {
    renderWithI18n(<Component runtime={quotaRuntime(true)} now={NOW} />);
    expect(screen.getAllByText("Reset, awaiting refresh")).toHaveLength(2);
    expect(screen.queryByText("Not reported")).not.toBeInTheDocument();
    expect(screen.queryByText("Rate limited")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows a collector snapshot as stale after an hour", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={quotaRuntime()} now={NOW + 3600 * 1000} />);
    expect(screen.getByText("Stale data")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it.each([
    ["zh-Hans", "已重置，等待刷新"],
    ["ja", "リセット済み、更新待ち"],
    ["ko", "초기화됨, 업데이트 대기 중"],
    ["fr", "Réinitialisé, en attente de mise à jour"],
  ] as const)("translates waiting state in %s", (locale, text) => {
    renderWithI18n(<RuntimeQuotaCell runtime={quotaRuntime()} now={NOW} />, { locale });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("keeps waiting and stale machine chips visible with matching accessible text", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const runtime = quotaRuntime(true);
    const machine = buildRuntimeMachines([runtime], { now: NOW })[0]!;
    const { rerender } = renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} />);
    expect(screen.getByLabelText(/: Reset, awaiting refresh$/, { selector: '[data-slot="tooltip-trigger"]' })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    const later = NOW + 3600 * 1000;
    rerender(<MachineQuotaChips machine={buildRuntimeMachines([runtime], { now: later })[0]!} now={later} />);
    expect(screen.getByLabelText(/: Stale data$/, { selector: '[data-slot="tooltip-trigger"]' })).toBeInTheDocument();
  });

  it("keeps reset groups in the machine chip tooltip alongside current windows", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const machine = buildRuntimeMachines([quotaRuntime()], { now: NOW })[0]!;
    renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} />);
    await userEvent.hover(screen.getByLabelText(/: Reset, awaiting refresh$/, { selector: '[data-slot="tooltip-trigger"]' }));
    const tooltip = (await screen.findByText("Gemini · 5h")).closest('[data-slot="tooltip-content"]');
    expect(tooltip).toHaveTextContent("Gemini");
    expect(tooltip).toHaveTextContent("Claude + GPT");
    expect(tooltip).toHaveTextContent("Reset, awaiting refresh");
    expect(tooltip).toHaveTextContent("75%");
  });

  it("hides stale balances and reset countdowns in the machine chip tooltip", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const runtime = quotaRuntime();
    runtime.plan_quota!.observed_at = NOW_SEC - 2 * 3600;
    const machine = buildRuntimeMachines([runtime], { now: NOW })[0]!;
    renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} />);
    await userEvent.hover(screen.getByLabelText(/: Stale data$/, { selector: '[data-slot="tooltip-trigger"]' }));
    const tooltip = (await screen.findByText("Gemini · 5h")).closest<HTMLElement>('[data-slot="tooltip-content"]');
    expect(tooltip).toHaveTextContent("Gemini");
    expect(tooltip).toHaveTextContent("Claude + GPT");
    expect(within(tooltip!).getAllByText("Stale data")).toHaveLength(2);
    expect(tooltip).not.toHaveTextContent("%");
    expect(tooltip).not.toHaveTextContent("resets at");
  });
});

describe("MiniMeterBar", () => {
  it("fills with the tone's color by default", () => {
    const { container } = render(
      <MiniMeterBar percent={50} tone="destructive" ariaLabel="q" />,
    );
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator?.className).toContain(TONE_BAR_CLASS.destructive);
  });

  it("lets the caller override the fill for non-health states", () => {
    // A stale host-metrics sample passes a neutral gray: it is not a health
    // judgment, so it must not inherit the (green) "ok" tone.
    const { container } = render(
      <MiniMeterBar
        percent={95}
        tone="ok"
        barClassName="bg-muted-foreground/50"
        ariaLabel="cpu"
      />,
    );
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator?.className).toContain("bg-muted-foreground/50");
    expect(indicator?.className).not.toContain(TONE_BAR_CLASS.ok);
  });
});

describe("fully replenished windows (OL-141 four-window shape)", () => {
  function fourWindowRuntime(): AgentRuntime {
    const runtime = quotaRuntime();
    runtime.plan_quota!.status = "limited";
    runtime.plan_quota!.windows = [
      { name: "gemini_5h", group: "gemini", used_percent: 1, window_minutes: 300, resets_at: NOW_SEC + 5 * 3600 },
      { name: "gemini_weekly", group: "gemini", used_percent: 20, window_minutes: 10080, resets_at: NOW_SEC + 3600 },
      // Fully replenished: no reset time, so no countdown and never the
      // "reset, awaiting refresh" state.
      { name: "claude_gpt_5h", group: "claude_gpt", used_percent: 0, window_minutes: 300, resets_at: null },
      { name: "claude_gpt_weekly", group: "claude_gpt", used_percent: 100, window_minutes: 10080, resets_at: NOW_SEC + 3 * 24 * 3600 },
    ];
    return runtime;
  }

  it("renders all four pool windows in the list cell with one soonest countdown", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={fourWindowRuntime()} now={NOW} />);
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("Claude + GPT")).toBeInTheDocument();
    expect(screen.getAllByText("5h")).toHaveLength(2);
    expect(screen.getAllByText("wk")).toHaveLength(2);
    expect(screen.queryByText("Reset, awaiting refresh")).not.toBeInTheDocument();
    // Only the view-level soonest reset line exists; the replenished window
    // contributes no countdown of its own.
    expect(screen.getAllByText(/resets at /)).toHaveLength(1);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
  });

  it("renders per-window countdowns in the settings card, none for the replenished window", () => {
    renderWithI18n(<RuntimeQuotaCard runtime={fourWindowRuntime()} now={NOW} />);
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("Claude + GPT")).toBeInTheDocument();
    expect(screen.queryByText("Reset, awaiting refresh")).not.toBeInTheDocument();
    expect(screen.getAllByText(/resets at /)).toHaveLength(3);
    expect(screen.getByText("100% left")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
  });

  it("lists every window in the machine chip tooltip and keeps the chip on the exhausted pool", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const machine = buildRuntimeMachines([fourWindowRuntime()], { now: NOW })[0]!;
    renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} />);
    await userEvent.hover(screen.getByLabelText(/: Rate limited$/, { selector: '[data-slot="tooltip-trigger"]' }));
    const tooltip = (await screen.findByText("Gemini · 5h")).closest<HTMLElement>('[data-slot="tooltip-content"]');
    for (const row of ["Gemini · 5h", "Gemini · wk", "Claude + GPT · 5h", "Claude + GPT · wk"]) {
      expect(within(tooltip!).getByText(row)).toBeInTheDocument();
    }
    expect(tooltip).toHaveTextContent("100%");
    expect(within(tooltip!).getAllByText(/resets at /)).toHaveLength(3);
    expect(tooltip).not.toHaveTextContent("Reset, awaiting refresh");
  });
});
