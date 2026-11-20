// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportedLocale } from "@multica/core/i18n";
import type { QuotaAccountPoolState } from "@multica/core/runtimes";
import type {
  Agent,
  AgentRuntime,
  RuntimePlanQuotaWindow,
} from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { buildRuntimeMachines } from "./runtime-machines";
import { MachineQuotaChips } from "./machine-quota-chips";
import { formatQuotaTime } from "./quota-time";
import {
  MiniMeterBar,
  RuntimeQuotaCard,
  RuntimeQuotaCell,
  TONE_BAR_CLASS,
} from "./runtime-quota-cell";
import { accountPoolRecoveryText } from "./runtime-quota-utils";

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

function ompAccount(
  label: string,
  status: string,
  remaining5h: number,
  remaining7d: number,
  note: string | null = null,
) {
  const windows: RuntimePlanQuotaWindow[] = status === "disabled" ? [] : [
    { name: "5h", used_percent: 100 - remaining5h, window_minutes: 300, resets_at: NOW_SEC + HOUR },
    { name: "7d", used_percent: 100 - remaining7d, window_minutes: 10080, resets_at: NOW_SEC + 4 * DAY },
  ];
  return { label, status, note, windows };
}

function ompPool(id: string, accounts: ReturnType<typeof ompAccount>[]) {
  const available = accounts.filter((account) => ["ok", "warning"].includes(account.status)).length;
  return {
    id,
    total_accounts: accounts.length,
    available_accounts: available,
    disabled_accounts: accounts.filter((account) => account.status === "disabled").length,
    status: available === 0 ? "limited" : "ok",
    resumes_at: null,
    accounts,
  };
}

function ompRuntime(): AgentRuntime {
  return quotaRuntime("omp", {
    account_pools: [
      ompPool("kimi-code", [
        ompAccount("19*", "exhausted", 0, 65),
        ompAccount("as*", "ok", 85, 80),
        ompAccount("de*", "ok", 100, 95),
      ]),
      ompPool("anthropic", [
        ompAccount("ca*9*", "ok", 72, 60),
        ompAccount("di*7*", "disabled", 0, 0, "oauth refresh failed"),
      ]),
      ompPool("openai-codex", [ompAccount("7f*", "ok", 55, 70)]),
      ompPool("zai", [ompAccount("mo*", "ok", 100, 100)]),
    ],
  });
}

function quotaAgent(model: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${model}`,
    runtime_id: "runtime-omp",
    model,
    custom_args: [],
    archived_at: null,
    ...overrides,
  } as Agent;
}


function renderChips(
  runtime: AgentRuntime,
  locale: SupportedLocale = "en",
  agents: Agent[] = [],
) {
  const machine = buildRuntimeMachines([runtime], { now: NOW })[0]!;
  return renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} agents={agents} />, { locale });
}

function chipTrigger(label: RegExp) {
  return screen.getByLabelText(label, { selector: '[data-slot="hover-card-trigger"]' });
}

describe("CLI quota subjects", () => {
  it("flows each independent subject's windows horizontally and keeps healthy values neutral", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={antigravityRuntime()} now={NOW} />);

    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("Claude + GPT")).toBeInTheDocument();
    expect(screen.getAllByText("100%")).toHaveLength(2);
    for (const value of screen.getAllByText("100%")) {
      expect(value).not.toHaveClass("text-success");
    }
    expect(screen.getByText("Not applicable now")).toBeInTheDocument();
    expect(screen.getByText("Exhausted")).toHaveClass("text-destructive");
    expect(screen.queryByText(/Rate limited ·/)).not.toBeInTheDocument();
  });

  it("opens one card with both model pools and absolute recovery", async () => {
    renderChips(antigravityRuntime());
    const trigger = chipTrigger(/^Antigravity: Gemini: 100% left · Claude \+ GPT: Rate limited$/);
    expect(screen.getAllByLabelText(/^Antigravity:/)).toHaveLength(1);
    await userEvent.hover(trigger);

    const context = await screen.findByText("Antigravity · dev.local");
    const card = context.closest<HTMLElement>('[data-slot="hover-card-content"]')!;
    expect(within(card).getByText("Gemini")).toBeInTheDocument();
    expect(within(card).getByText("Claude + GPT")).toBeInTheDocument();
    expect(within(card).getByText(/via daemon · updated/)).toBeInTheDocument();
    expect(within(card).getByText("Not applicable now")).toBeInTheDocument();
    expect(within(card).getByText("Exhausted")).toBeInTheDocument();
    expect(within(card).getByText(`recovers at ${at(NOW_SEC + 2 * DAY)}`)).toBeInTheDocument();
    expect(card.querySelectorAll("table")).toHaveLength(0);
  });

  it("keeps each window's reset and passed reset in the detail card", () => {
    renderWithI18n(<RuntimeQuotaCard runtime={claudeRuntime()} now={NOW} />);

    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("86%")).toBeInTheDocument();
    expect(screen.getByText(`reset at ${at(NOW_SEC - HOUR)}`)).toBeInTheDocument();
    expect(screen.getByText(`resets at ${at(NOW_SEC + 4 * DAY)}`)).toBeInTheDocument();
    expect(screen.getByText("updated 4h ago")).toBeInTheDocument();
  });

  it("omits an invalid reset instead of breaking the card", () => {
    const runtime = quotaRuntime("claude", {
      windows: [{ name: "five_hour", used_percent: 50, window_minutes: 300, resets_at: 9_000_000_000_000 }],
    });
    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);

    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.queryByText(/resets at/)).not.toBeInTheDocument();
  });

  it("keeps an unmeasured window neutral instead of treating it as healthy", () => {
    const runtime = quotaRuntime("claude", {
      windows: [{ name: "five_hour", used_percent: null, window_minutes: 300, resets_at: NOW_SEC + HOUR }],
    });
    const cell = renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    expect(screen.getByText("Balance unknown")).toHaveClass("text-faint-foreground");
    cell.unmount();

    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);
    expect(screen.getByText("Balance unknown")).toHaveClass("text-faint-foreground");
  });

  it("keeps an unattributed provider limit visible in the detail card", () => {
    const runtime = quotaRuntime("claude", {
      status: "limited",
      windows: [
        { name: "five_hour", used_percent: 98, window_minutes: 300, resets_at: NOW_SEC + HOUR },
        { name: "seven_day", used_percent: 40, window_minutes: 10080, resets_at: NOW_SEC + 3 * DAY },
      ],
    });
    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);

    expect(screen.getByText("Rate limited")).toHaveClass("text-destructive");
    expect(screen.getByText("2%")).toBeInTheDocument();
    expect(screen.getByText(`resets at ${at(NOW_SEC + HOUR)}`)).toBeInTheDocument();
  });
});

describe("grouped Runtime detail cards", () => {
  it("labels each Antigravity model pool and uses absolute recovery", () => {
    const { container } = renderWithI18n(
      <RuntimeQuotaCard runtime={antigravityRuntime()} now={NOW} />,
    );

    const gemini = container.querySelector('[data-quota-group="gemini"]');
    const claudeGpt = container.querySelector('[data-quota-group="claude_gpt"]');
    expect(gemini).not.toBeNull();
    expect(claudeGpt).not.toBeNull();
    expect(within(gemini as HTMLElement).getByText("Gemini")).toBeInTheDocument();
    expect(within(claudeGpt as HTMLElement).getByText("Claude + GPT")).toBeInTheDocument();
    expect(within(claudeGpt as HTMLElement).getByText(`recovers at ${at(NOW_SEC + 2 * DAY)}`)).toBeInTheDocument();
  });
});

describe("snapshot availability and interruption", () => {
  it("shows a neutral no-snapshot chip and an explicit empty hover state", async () => {
    const runtime = claudeRuntime();
    runtime.plan_quota = null;
    renderChips(runtime);

    const trigger = chipTrigger(/Claude: No snapshot$/);
    expect(trigger).toHaveClass("bg-muted");
    await userEvent.hover(trigger);
    expect(await screen.findByText("No quota snapshot")).toBeInTheDocument();
  });

  it("uses the same empty copy in the table and detail card", () => {
    const runtime = claudeRuntime();
    runtime.plan_quota = null;
    const cell = renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    expect(screen.getByText("No quota snapshot")).toBeInTheDocument();
    cell.unmount();

    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);
    expect(screen.getByText("No quota snapshot")).toBeInTheDocument();
  });

  it("keeps interrupted values muted and reports the last update", async () => {
    const cell = renderWithI18n(<RuntimeQuotaCell runtime={kimiRuntime()} now={NOW} />);
    expect(screen.getByText("80%")).toHaveClass("text-faint-foreground");
    expect(screen.getByText(`Collection interrupted · last updated ${at(NOW_SEC - 30 * HOUR)}`)).toBeInTheDocument();
    cell.unmount();

    renderChips(kimiRuntime());
    const trigger = chipTrigger(/: 80% left · Collection interrupted$/);
    expect(trigger).toHaveClass("bg-muted");
    await userEvent.hover(trigger);
    const warning = await screen.findByText(`Collection interrupted · last updated ${at(NOW_SEC - 30 * HOUR)}`);
    expect(warning).toHaveClass("text-warning");
  });

  it("does not interrupt a task-reported snapshot merely because it is old", () => {
    renderWithI18n(
      <RuntimeQuotaCell
        runtime={quotaRuntime("codex", {
          observed_at: NOW_SEC - 36 * HOUR,
          windows: [{ name: "primary", used_percent: 59, window_minutes: 10080, resets_at: NOW_SEC + DAY }],
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("41%")).toHaveClass("text-foreground");
    expect(screen.queryByText(/Collection interrupted/)).not.toBeInTheDocument();
  });
});

describe("OMP account pools", () => {
  const servingAgents = () => [
    quotaAgent("kimi-code/k2.5"),
    quotaAgent("anthropic/claude-sonnet-4-6"),
  ];

  it("lists only serving pools as horizontal subjects without idle-pool entries", () => {
    renderWithI18n(
      <RuntimeQuotaCell runtime={ompRuntime()} now={NOW} agents={servingAgents()} />,
    );

    expect(screen.getByText("Kimi Code")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    expect(screen.queryByText("Z.AI")).not.toBeInTheDocument();
    expect(screen.queryByText(/idle pool/)).not.toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it.each([
    ["no bound agents", []],
    ["a default model", [quotaAgent("k2.5")]],
    ["no reported provider intersection", [quotaAgent("other/model")]],
    ["only archived agents", [quotaAgent("kimi-code/k2.5", { archived_at: new Date(NOW).toISOString() })]],
  ])("falls back to every pool with %s", (_label, agents) => {
    renderWithI18n(<RuntimeQuotaCell runtime={ompRuntime()} now={NOW} agents={agents} />);

    expect(screen.getByText("Kimi Code")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Z.AI")).toBeInTheDocument();
  });

  it("keeps serving providers inside one OMP machine capsule", () => {
    const { container } = renderChips(ompRuntime(), "en", servingAgents());

    expect(container.querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(1);
    const trigger = chipTrigger(/^Omp: Kimi Code:/);
    expect(within(trigger).getByText("Omp")).toBeInTheDocument();
    expect(within(trigger).getByText("Kimi Code")).toBeInTheDocument();
    expect(within(trigger).getByText("Claude")).toBeInTheDocument();
    expect(within(trigger).getByText("62%")).toBeInTheDocument();
    expect(within(trigger).getByText("60%")).toBeInTheDocument();
    expect(within(trigger).queryByText("Codex")).not.toBeInTheDocument();
    expect(within(trigger).queryByText("Z.AI")).not.toBeInTheDocument();
  });

  it("uses the tightest OMP pool window for the machine capsule and meter", () => {
    const runtime = quotaRuntime("omp", {
      account_pools: [ompPool("zai", [ompAccount("ze*", "ok", 99, 15)])],
    });
    renderChips(runtime);

    const trigger = chipTrigger(/^Omp: Z.AI:/);
    expect(within(trigger).getByText("15%")).toBeInTheDocument();
    expect(within(trigger).queryByText("99%")).not.toBeInTheDocument();
    expect(within(trigger).getByRole("progressbar", { name: "Omp Z.AI", hidden: true })).toHaveAttribute("aria-valuenow", "15");
  });

  it("combines serving provider pools and their account tables in one hover card", async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <RuntimeQuotaCell runtime={ompRuntime()} now={NOW} agents={servingAgents()} />,
    );
    const trigger = screen.getByText("Kimi Code").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!;
    await user.hover(trigger);

    const account = await screen.findByText("#1 (19*)");
    const card = account.closest<HTMLElement>('[data-slot="hover-card-content"]')!;
    expect(within(card).getByText("Kimi Code")).toBeInTheDocument();
    expect(within(card).getByText("Claude")).toBeInTheDocument();
    expect(within(card).queryByText("Codex")).not.toBeInTheDocument();
    expect(within(card).queryByText("Z.AI")).not.toBeInTheDocument();
    expect(within(card).getByText("2/3 accounts available")).toBeInTheDocument();
    expect(within(card).getByText("1/2 accounts available")).toBeInTheDocument();
    const tables = within(card).getAllByRole("table");
    expect(tables).toHaveLength(2);
    expect(within(tables[0]!).getByRole("columnheader", { name: "Account" })).toBeInTheDocument();
    expect(within(tables[0]!).getAllByRole("columnheader", { name: "5h" })).toHaveLength(1);
    expect(within(tables[0]!).getAllByRole("columnheader", { name: "7d" })).toHaveLength(1);
    expect(within(card).getByText("#2 (as*)")).toBeInTheDocument();
    expect(within(card).getByText("#3 (de*)")).toBeInTheDocument();
    expect(within(card).getByText("#1 (ca*9*)")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("#1 (19*)")).not.toBeInTheDocument());
  });

  it("deduplicates legacy Kimi windows and keeps long custom labels out of the meter column", async () => {
    const account = {
      ...ompAccount("19*", "ok", 60, 38),
      windows: [
        { name: "7d", used_percent: 62, window_minutes: 10080, resets_at: NOW_SEC + 4 * DAY },
        { name: "limit_7d", used_percent: 62, window_minutes: null, resets_at: NOW_SEC + 4 * DAY },
        { name: "limit_5h", used_percent: 40, window_minutes: null, resets_at: NOW_SEC + HOUR },
        { name: "limit_custom_window", used_percent: 20, window_minutes: null, resets_at: NOW_SEC + 2 * DAY },
      ] satisfies RuntimePlanQuotaWindow[],
    };
    const runtime = quotaRuntime("omp", { account_pools: [ompPool("kimi-code", [account])] });
    renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    const trigger = screen.getByText("Kimi Code").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!;
    await userEvent.hover(trigger);

    const accountRow = await screen.findByText("#1 (19*)");
    const card = accountRow.closest<HTMLElement>('[data-slot="hover-card-content"]')!;
    const customLabel = within(card).getByText("limit_custom_window", { selector: "span" });
    expect(within(card).queryByText("limit_7d")).not.toBeInTheDocument();
    expect(within(card).queryByText("limit_5h")).not.toBeInTheDocument();
    expect(within(card).getAllByRole("columnheader", { name: "5h" })).toHaveLength(1);
    expect(within(card).getAllByRole("columnheader", { name: "7d" })).toHaveLength(1);
    expect(customLabel).toHaveClass("max-w-20", "truncate", "whitespace-nowrap");
    expect(customLabel.parentElement).toHaveClass(
      "grid-cols-[minmax(1.75rem,auto)_minmax(3rem,1fr)_auto]",
    );
    expect(within(card).getByRole("columnheader", { name: "limit_custom_window" }))
      .toHaveClass("min-w-12", "whitespace-nowrap");
  });

  it("moves a multi-account pool's resets into each account row", async () => {
    renderWithI18n(
      <RuntimeQuotaCell runtime={ompRuntime()} now={NOW} agents={servingAgents()} />,
    );
    await userEvent.hover(
      screen.getByText("Kimi Code").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!,
    );

    const accountRow = await screen.findByText("#1 (19*)");
    const section = accountRow.closest<HTMLElement>('[data-hover-account-pool="kimi-code"]')!;
    const poolWindows = Array.from(section.querySelectorAll<HTMLElement>("[data-pool-window]"));
    expect(poolWindows).toHaveLength(2);
    for (const row of poolWindows) {
      expect(row).not.toHaveTextContent(/resets at |recovers at /);
    }

    // Three accounts, two windows each: the exhausted 5h window recovers, the
    // other five report their own reset.
    expect(within(section).getAllByText(`resets at ${at(NOW_SEC + HOUR)}`)).toHaveLength(2);
    expect(within(section).getAllByText(`resets at ${at(NOW_SEC + 4 * DAY)}`)).toHaveLength(3);
    expect(within(section).getByText(`recovers at ${at(NOW_SEC + HOUR)}`)).toBeInTheDocument();
  });

  it("keeps the aggregated reset for a single-account pool", async () => {
    const runtime = quotaRuntime("omp", {
      account_pools: [ompPool("kimi-code", [ompAccount("19*", "ok", 85, 80)])],
    });
    renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    await userEvent.hover(
      screen.getByText("Kimi Code").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!,
    );

    const accountRow = await screen.findByText("#1 (19*)");
    const section = accountRow.closest<HTMLElement>('[data-hover-account-pool="kimi-code"]')!;
    const poolWindows = Array.from(section.querySelectorAll<HTMLElement>("[data-pool-window]"));
    expect(poolWindows[0]).toHaveTextContent(`resets at ${at(NOW_SEC + HOUR)}`);
    expect(poolWindows[1]).toHaveTextContent(`resets at ${at(NOW_SEC + 4 * DAY)}`);
    expect(within(section).getAllByText(`resets at ${at(NOW_SEC + HOUR)}`)).toHaveLength(2);
  });

  it("shows each account's resets in Runtime details instead of the pool aggregate", () => {
    const { container } = renderWithI18n(
      <RuntimeQuotaCard runtime={ompRuntime()} now={NOW} agents={servingAgents()} />,
    );

    const matrix = container.querySelector<HTMLElement>('[data-account-pool-matrix="kimi-code"]')!;
    const poolWindows = Array.from(matrix.querySelectorAll<HTMLElement>("[data-pool-window]"));
    expect(poolWindows).toHaveLength(2);
    for (const row of poolWindows) {
      expect(row).not.toHaveTextContent(/resets at |recovers at /);
    }
    expect(within(matrix).getAllByText(`resets at ${at(NOW_SEC + 4 * DAY)}`)).toHaveLength(3);
    expect(within(matrix).getAllByText(`resets at ${at(NOW_SEC + HOUR)}`)).toHaveLength(2);
    expect(within(matrix).getByText(`recovers at ${at(NOW_SEC + HOUR)}`)).toBeInTheDocument();
  });

  it("opens on keyboard focus", async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <RuntimeQuotaCell runtime={ompRuntime()} now={NOW} agents={[quotaAgent("kimi-code/k2.5")]} />,
    );
    const trigger = screen.getByText("Kimi Code").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!;
    await user.tab();

    expect(trigger).toHaveFocus();
    expect(await screen.findByText("#1 (19*)")).toBeInTheDocument();
  });

  it("caps hover accounts at four and points the remainder to Runtime details", async () => {
    const runtime = quotaRuntime("omp", {
      account_pools: [
        ompPool("kimi-code", ["a", "b", "c", "d", "e"].map((label) => ompAccount(label, "ok", 85, 80))),
      ],
    });
    renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    await userEvent.hover(screen.getByText("Kimi Code").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!);

    expect(await screen.findByText("#4 (d)")).toBeInTheDocument();
    expect(screen.queryByText("#5 (e)")).not.toBeInTheDocument();
    expect(screen.getByText("1 more account; open Runtime details to view it")).toBeInTheDocument();
  });

  it("shows one re-login warning when every account is invalid", async () => {
    const runtime = quotaRuntime("omp", {
      account_pools: [
        ompPool("zai", [ompAccount("di*", "disabled", 0, 0)]),
      ],
    });
    renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    expect(screen.getByText("Re-login required")).toHaveClass("text-warning");
    const trigger = screen.getByText("Z.AI").closest<HTMLElement>('[data-slot="hover-card-trigger"]')!;
    await userEvent.hover(trigger);

    expect(await screen.findByText("Every account in this pool requires re-login.")).toHaveClass("text-warning");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("returns no recovery text for an all-disabled re-login pool", () => {
    const pool = {
      id: "zai",
      accounts: [{ label: "di*", status: "disabled", usable: false, note: "oauth refresh failed", windows: [] }],
      windows: [],
      totalAccounts: 1,
      availableAccounts: 0,
      disabledAccounts: 1,
      exhausted: true,
      remainingPercent: null,
      resumesAt: NOW_SEC + HOUR,
      resumesAccountIndex: 0,
      tone: "warning",
    } satisfies QuotaAccountPoolState;
    const t = vi.fn() as unknown as Parameters<typeof accountPoolRecoveryText>[2];
    const formatTime = vi.fn();

    expect(accountPoolRecoveryText(pool, NOW, t, formatTime)).toBeNull();
    expect(formatTime).not.toHaveBeenCalled();
  });

  it("shows serving pools in details and expands idle pools on demand", async () => {
    const { container } = renderWithI18n(
      <RuntimeQuotaCard runtime={ompRuntime()} now={NOW} agents={servingAgents()} />,
    );

    expect(container.querySelectorAll("[data-account-pool-matrix]")).toHaveLength(2);
    expect(screen.getByText("#1 (19*)")).toBeInTheDocument();
    expect(screen.getByText("#1 (ca*9*)")).toBeInTheDocument();
    expect(screen.queryByText("#1 (7f*)")).not.toBeInTheDocument();
    expect(screen.queryByText("#1 (mo*)")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "2 idle provider pools" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("[data-account-pool-matrix]")).toHaveLength(4);
    expect(screen.getByText("Codex").parentElement).toHaveTextContent("· Not used");
    expect(screen.getByText("Z.AI").parentElement).toHaveTextContent("· Not used");
    expect(screen.getByText("#1 (7f*)")).toBeInTheDocument();
    expect(screen.getByText("#1 (mo*)")).toBeInTheDocument();
    expect(screen.getByText("Re-login required")).toBeInTheDocument();
  });

  it("derives account table columns from reported windows", () => {
    const account = ompAccount("a", "ok", 85, 80);
    account.windows = [
      { name: "hourly", used_percent: 15, window_minutes: 60, resets_at: NOW_SEC + HOUR },
      { name: "daily", used_percent: 20, window_minutes: 1440, resets_at: NOW_SEC + DAY },
    ];
    const runtime = quotaRuntime("omp", { account_pools: [ompPool("kimi-code", [account])] });
    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "1h" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "1d" })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "5h" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "7d" })).not.toBeInTheDocument();
  });

  it("uses the no-snapshot state for a pool without windows", async () => {
    const account = ompAccount("a", "ok", 85, 80);
    account.windows = [];
    const runtime = quotaRuntime("omp", { account_pools: [ompPool("kimi-code", [account])] });
    const chips = renderChips(runtime);
    const trigger = chipTrigger(/Omp: Kimi Code: 1 of 1 accounts available/);
    expect(within(trigger).getByText("No snapshot")).toBeInTheDocument();
    await userEvent.hover(trigger);
    expect(await screen.findByText("No quota snapshot")).toBeInTheDocument();
    chips.unmount();

    const cell = renderWithI18n(<RuntimeQuotaCell runtime={runtime} now={NOW} />);
    expect(screen.getByText("No quota snapshot")).toBeInTheDocument();
    cell.unmount();

    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);
    expect(screen.getByText("No quota snapshot")).toBeInTheDocument();
  });

  it.each(["k2.5", "other/model"])(
    "does not mark fallback pools unused when an active agent uses %s",
    (model) => {
      renderWithI18n(
        <RuntimeQuotaCard runtime={ompRuntime()} now={NOW} agents={[quotaAgent(model)]} />,
      );

      for (const name of ["Kimi Code", "Claude", "Codex", "Z.AI"]) {
        expect(screen.getByText(name).parentElement).not.toHaveTextContent("Not used");
      }
    },
  );

  it("does not mark pools unused while the agent list is pending", () => {
    renderWithI18n(
      <RuntimeQuotaCard runtime={ompRuntime()} now={NOW} agents={[]} agentsPending />,
    );

    for (const name of ["Kimi Code", "Claude", "Codex", "Z.AI"]) {
      expect(screen.getByText(name).parentElement).not.toHaveTextContent("Not used");
    }
  });

  it("marks every pool unused when the Runtime has no active agents", () => {
    renderWithI18n(<RuntimeQuotaCard runtime={ompRuntime()} now={NOW} agents={[]} />);

    for (const name of ["Kimi Code", "Claude", "Codex", "Z.AI"]) {
      expect(screen.getByText(name).parentElement).toHaveTextContent("· Not used");
    }
  });

  it("shows the earliest recovering account as an absolute time", () => {
    const first = ompAccount("19*", "exhausted", 0, 65);
    const second = ompAccount("as*", "exhausted", 0, 12);
    first.windows[0]!.resets_at = NOW_SEC + 4320;
    second.windows[0]!.resets_at = NOW_SEC + HOUR;
    const runtime = quotaRuntime("omp", {
      account_pools: [ompPool("kimi-code", [first, second])],
    });
    renderWithI18n(<RuntimeQuotaCard runtime={runtime} now={NOW} />);

    expect(screen.getByText(`Earliest recovery at ${at(NOW_SEC + HOUR)} (#2)`)).toBeInTheDocument();
    expect(screen.queryByText(/All accounts in this provider pool/)).not.toBeInTheDocument();
  });
});


describe("localized quota states", () => {
  it("uses explicit Chinese exhaustion copy", () => {
    renderWithI18n(<RuntimeQuotaCell runtime={antigravityRuntime()} now={NOW} />, { locale: "zh-Hans" });
    expect(screen.getByText("已耗尽")).toBeInTheDocument();
    expect(screen.getByText("暂不适用")).toBeInTheDocument();
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
    const { container } = render(
      <MiniMeterBar percent={95} tone="ok" barClassName="bg-muted-foreground/50" ariaLabel="cpu" />,
    );
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator?.className).toContain("bg-muted-foreground/50");
    expect(indicator?.className).not.toContain(TONE_BAR_CLASS.ok);
  });
});
