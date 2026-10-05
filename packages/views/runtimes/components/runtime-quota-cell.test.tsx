// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
