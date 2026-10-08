// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportedLocale } from "@multica/core/i18n";
import type { AgentRuntime } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { buildRuntimeMachines } from "./runtime-machines";
import { MachineQuotaChips } from "./machine-quota-chips";
import { formatQuotaTime } from "./quota-time";
import { MiniMeterBar, RuntimeQuotaCard, RuntimeQuotaCell, TONE_BAR_CLASS } from "./runtime-quota-cell";

const viewer = vi.hoisted(() => ({ timezone: "Asia/Shanghai" as string | null }));

vi.mock("@multica/core/auth", () => {
  type AuthState = { user: { timezone: string | null } };
  const state = (): AuthState => ({ user: { timezone: viewer.timezone } });
  const useAuthStore = Object.assign(
    (sel: (s: AuthState) => unknown) => sel(state()),
    { getState: state },
  );
  return { useAuthStore };
});

const NOW_SEC = 1_800_000_000;
const NOW = NOW_SEC * 1000;
const HOUR = 3600;
const DAY = 24 * HOUR;

function at(sec: number, locale = "en", timeZone = "Asia/Shanghai") {
  return formatQuotaTime(sec, NOW, timeZone, locale);
}

beforeEach(() => {
  viewer.timezone = "Asia/Shanghai";
});
afterEach(() => vi.restoreAllMocks());

function quotaRuntime(provider: string, quota: Record<string, unknown>): AgentRuntime {
  const title = provider[0]!.toUpperCase() + provider.slice(1);
  return {
    id: `runtime-${provider}`, workspace_id: "workspace-1", daemon_id: "daemon-1",
    name: `${title} (dev.local)`, provider, runtime_mode: "local",
    status: "online", owner_id: "user-1", visibility: "private", device_info: "",
    metadata: {}, launch_header: "", last_seen_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    plan_quota: {
      provider, status: "ok", source: "daemon", observed_at: NOW_SEC - 60, windows: [],
      ...quota,
    } as AgentRuntime["plan_quota"],
  };
}

// Live 10-08 shapes, shifted onto NOW.
function antigravityRuntime(): AgentRuntime {
  return quotaRuntime("antigravity", {
    status: "limited",
    windows: [
      { name: "gemini_5h", group: "gemini", used_percent: 0, window_minutes: 300, resets_at: null },
      { name: "gemini_weekly", group: "gemini", used_percent: 0, window_minutes: 10080, resets_at: null },
      { name: "claude_gpt_5h", group: "claude_gpt", used_percent: 0, window_minutes: 300, resets_at: null },
      { name: "claude_gpt_weekly", group: "claude_gpt", used_percent: 100, window_minutes: 10080, resets_at: NOW_SEC + 2 * DAY },
    ],
  });
}

function claudeRuntime(): AgentRuntime {
  return quotaRuntime("claude", {
    observed_at: NOW_SEC - 4 * HOUR,
    windows: [
      { name: "five_hour", used_percent: 1, window_minutes: 300, resets_at: NOW_SEC - HOUR },
      { name: "seven_day", used_percent: 14, window_minutes: 10080, resets_at: NOW_SEC + 4 * DAY },
    ],
  });
}

function kimiRuntime(): AgentRuntime {
  return quotaRuntime("kimi", {
    observed_at: NOW_SEC - 30 * HOUR,
    windows: [
      { name: "primary", used_percent: 0, window_minutes: 300, resets_at: NOW_SEC - 25 * HOUR },
      { name: "secondary", used_percent: 20, window_minutes: 10080, resets_at: NOW_SEC + 3 * DAY },
    ],
  });
}

function renderChips(runtime: AgentRuntime, locale: SupportedLocale = "en") {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  const machine = buildRuntimeMachines([runtime], { now: NOW })[0]!;
  return renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} />, { locale });
}

function chipTrigger(label: RegExp) {
  return screen.getByLabelText(label, { selector: '[data-slot="tooltip-trigger"]' });
}

describe("a used-up pool next to an untouched one (antigravity)", () => {
  it("limits only that pool in the list cell", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={antigravityRuntime()} now={NOW} />);
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("Claude + GPT")).toBeInTheDocument();
    const full = screen.getAllByText("100%");
    expect(full).toHaveLength(2);
    for (const value of full) expect(value).toHaveClass("text-success");
    expect(screen.getByText("Not applicable now")).toBeInTheDocument();
    expect(screen.getByText("0%")).toHaveClass("text-destructive");
    expect(screen.getByText(`Rate limited · resets at ${at(NOW_SEC + 2 * DAY)}`)).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  });

  it("states the recovery in the settings card and sets the 5h window aside", () => {
    renderWithI18n(<RuntimeQuotaCard runtime={antigravityRuntime()} now={NOW} />);
    expect(screen.getAllByText("100% left")).toHaveLength(2);
    expect(screen.getByText("Not applicable now")).toBeInTheDocument();
    expect(screen.getByText("0% left")).toBeInTheDocument();
    expect(screen.getByText(`Rate limited · resets at ${at(NOW_SEC + 2 * DAY)}`)).toBeInTheDocument();
    expect(screen.getByText(`resets at ${at(NOW_SEC + 2 * DAY)}`)).toBeInTheDocument();
    expect(screen.getByText("updated 1m ago")).toBeInTheDocument();
  });

  it("gives each pool its own machine chip and tooltip rows", async () => {
    renderChips(antigravityRuntime());
    expect(chipTrigger(/ · Gemini: 100% left$/)).toHaveClass("text-success");
    const limited = chipTrigger(/ · Claude \+ GPT: Rate limited$/);
    await userEvent.hover(limited);
    const tooltip = (await screen.findByText("Claude + GPT · 5h")).closest<HTMLElement>('[data-slot="tooltip-content"]')!;
    const rows = within(tooltip);
    expect(rows.getByText("Claude + GPT · 5h").parentElement).toHaveTextContent("Not applicable now");
    expect(rows.getByText("Claude + GPT · wk").parentElement).toHaveTextContent(`0%resets at ${at(NOW_SEC + 2 * DAY)}`);
    expect(rows.getByText("Gemini · wk").parentElement).toHaveTextContent("100%");
  });
});

describe("a five-hour window past its reset (claude)", () => {
  it("counts it as refilled and shows the weekly reset", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={claudeRuntime()} now={NOW} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("86%")).toBeInTheDocument();
    expect(screen.getByText(`resets at ${at(NOW_SEC + 4 * DAY)}`)).toBeInTheDocument();
  });

  it("notes when the window was refilled in the settings card", () => {
    renderWithI18n(<RuntimeQuotaCard runtime={claudeRuntime()} now={NOW} />);
    expect(screen.getByText("100% left")).toBeInTheDocument();
    expect(screen.getByText(`reset at ${at(NOW_SEC - HOUR)}`)).toBeInTheDocument();
    expect(screen.getByText("86% left")).toBeInTheDocument();
    expect(screen.getByText(`resets at ${at(NOW_SEC + 4 * DAY)}`)).toBeInTheDocument();
  });

  it("puts the weekly balance on the machine chip", () => {
    renderChips(claudeRuntime());
    expect(chipTrigger(/: 86% left$/)).toHaveClass("text-success");
  });
});

describe("an interrupted collector (kimi)", () => {
  it("keeps the last balance uncolored and flags the interruption", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={kimiRuntime()} now={NOW} />);
    expect(screen.getByText("80%")).toHaveClass("text-faint-foreground");
    expect(screen.getByText(`Collection interrupted · last updated ${at(NOW_SEC - 30 * HOUR)}`)).toBeInTheDocument();
  });

  it("flags the machine chip and the settings card", () => {
    renderChips(kimiRuntime());
    expect(chipTrigger(/: 80% left · Collection interrupted$/)).toHaveClass("bg-muted");
    renderWithI18n(<RuntimeQuotaCard runtime={kimiRuntime()} now={NOW} />);
    expect(screen.getByText(`Collection interrupted · last updated ${at(NOW_SEC - 30 * HOUR)}`)).toBeInTheDocument();
  });

  it("never interrupts a task-reported snapshot that is merely old", () => {
    renderWithI18n(
      <RuntimeQuotaCell
        runtime={quotaRuntime("codex", {
          observed_at: NOW_SEC - 36 * HOUR,
          windows: [{ name: "primary", used_percent: 59, window_minutes: 10080, resets_at: NOW_SEC + DAY }],
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("41%")).toHaveClass("text-success");
    expect(screen.queryByText(/Collection interrupted/)).not.toBeInTheDocument();
  });
});

describe("reset times", () => {
  it("follow the viewer's timezone preference", () => {
    viewer.timezone = "America/New_York";
    const { rerender } = renderWithI18n(<RuntimeQuotaCell runtime={claudeRuntime()} now={NOW} />);
    const newYork = at(NOW_SEC + 4 * DAY, "en", "America/New_York");
    expect(screen.getByText(`resets at ${newYork}`)).toBeInTheDocument();
    viewer.timezone = "Asia/Shanghai";
    rerender(<RuntimeQuotaCell runtime={claudeRuntime()} now={NOW} />);
    expect(newYork).not.toBe(at(NOW_SEC + 4 * DAY));
    expect(screen.getByText(`resets at ${at(NOW_SEC + 4 * DAY)}`)).toBeInTheDocument();
  });

  it("are never countdowns", () => {
    renderWithI18n(<RuntimeQuotaCard runtime={claudeRuntime()} now={NOW} />);
    expect(screen.queryByText(/resets at \d+h/)).not.toBeInTheDocument();
  });
});

describe("translated states", () => {
  it.each([
    ["zh-Hans", "暂不适用", `已限流 · ${at(NOW_SEC + 2 * DAY, "zh-Hans")} 重置`],
    ["ja", "現在は適用外", `レート制限中 · ${at(NOW_SEC + 2 * DAY, "ja")} にリセット`],
    ["ko", "현재 적용 안 됨", `속도 제한됨 · ${at(NOW_SEC + 2 * DAY, "ko")} 초기화`],
    ["fr", "Ne s'applique pas pour l'instant", `Limite atteinte · réinitialisation : ${at(NOW_SEC + 2 * DAY, "fr")}`],
  ] as const)("in %s", (locale, notApplicable, limited) => {
    renderWithI18n(<RuntimeQuotaCell runtime={antigravityRuntime()} now={NOW} />, { locale });
    expect(screen.getByText(notApplicable)).toBeInTheDocument();
    expect(screen.getByText(limited)).toBeInTheDocument();
  });

  it("reads the Chinese interruption and refill copy", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={kimiRuntime()} now={NOW} />, { locale: "zh-Hans" });
    expect(screen.getByText(`采集中断 · 最后更新 ${at(NOW_SEC - 30 * HOUR, "zh-Hans")}`)).toBeInTheDocument();
    renderWithI18n(<RuntimeQuotaCard runtime={claudeRuntime()} now={NOW} />, { locale: "zh-Hans" });
    expect(screen.getByText(`已于 ${at(NOW_SEC - HOUR, "zh-Hans")} 重置`)).toBeInTheDocument();
  });
});

describe("unmeasured windows", () => {
  it("are unknown, or rate limited when the snapshot says so", () => {
    const runtime = quotaRuntime("claude", {
      windows: [{ name: "five_hour", used_percent: null, window_minutes: 300, resets_at: NOW_SEC + HOUR }],
    });
    const { unmount } = renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    expect(screen.getByText("Balance unknown")).toBeInTheDocument();
    unmount();
    runtime.plan_quota!.status = "limited";
    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);
    expect(screen.getByText(`Rate limited · resets at ${at(NOW_SEC + HOUR)}`)).toBeInTheDocument();
    expect(screen.getAllByText("Rate limited")).toHaveLength(1);
  });

  it("shows not reported without a snapshot", () => {
    const runtime = quotaRuntime("claude", {});
    runtime.plan_quota = null;
    renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    expect(screen.getByText("Not reported")).toBeInTheDocument();
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
