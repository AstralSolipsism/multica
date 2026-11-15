// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceQuotaSource } from "@multica/core/api";
import { renderWithI18n } from "../../test/i18n";
import { SubscriptionQuotaCards } from "./subscription-quota-cards";
import { formatQuotaTime } from "./quota-time";

vi.mock("@multica/core/auth", () => {
  type AuthState = { user: { timezone: string } };
  const state = (): AuthState => ({ user: { timezone: "Asia/Shanghai" } });
  const useAuthStore = Object.assign(
    (select: (state: AuthState) => unknown) => select(state()),
    { getState: state },
  );
  return { useAuthStore };
});

const NOW_SEC = 1_800_000_000;
const NOW = NOW_SEC * 1000;

function source(overrides: Partial<WorkspaceQuotaSource> = {}): WorkspaceQuotaSource {
  return {
    id: "source-1",
    kind: "glm",
    name: "Primary GLM",
    owner_id: "owner-1",
    visibility: "private",
    is_own: true,
    quota: {
      provider: "glm",
      status: "ok",
      source: "subscription",
      observed_at: NOW_SEC - 120,
      windows: [
        { name: "tokens_300", group: "tokens", used_percent: 30, window_minutes: 300, resets_at: NOW_SEC + 3600 },
        { name: "tokens_10080", group: "tokens", used_percent: 60, window_minutes: 10080, resets_at: NOW_SEC + 86400 },
        { name: "tools", group: "tools", used_percent: 16, window_minutes: null, resets_at: NOW_SEC + 10 * 86400 },
      ],
    },
    last_polled_at: null,
    last_error: null,
    ...overrides,
  };
}

function chip(label: string) {
  return screen.getByText(label).closest<HTMLElement>('[data-slot="tooltip-trigger"]')!;
}

describe("SubscriptionQuotaCards", () => {
  it("renders channel, custom name, visibility and distinct GLM windows without plan or absolute usage", () => {
    renderWithI18n(<SubscriptionQuotaCards sources={[source()]} now={NOW} />);

    expect(screen.getByText("Primary GLM")).toBeInTheDocument();
    expect(screen.getByText("Zhipu GLM Coding Plan")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("5-hour tokens")).toBeInTheDocument();
    expect(screen.getByText("7d tokens")).toBeInTheDocument();
    expect(screen.getByText("Monthly tool credits")).toBeInTheDocument();
    expect(screen.getByText("70% left")).toBeInTheDocument();
    expect(screen.getByText("40% left")).toBeInTheDocument();
    expect(screen.getByText("84% left")).toBeInTheDocument();
    expect(screen.queryByText("MAX")).not.toBeInTheDocument();
    expect(screen.queryByText(/95 \/ 100/)).not.toBeInTheDocument();
    expect(screen.getByText("updated 2m ago")).toBeInTheDocument();
  });

  // OL-1205 review #4②: credit pools must carry their real period too —
  // two CREDIT_LIMIT windows render distinct 5h / weekly credit labels,
  // never two identical "credit" chips.
  it("labels 5-hour and weekly CREDIT_LIMIT windows distinctly", () => {
    const creditSource = source({
      name: "GLM Credit Plan",
      quota: {
        provider: "glm",
        status: "ok",
        source: "subscription",
        observed_at: NOW_SEC - 120,
        windows: [
          { name: "credits_300", group: "credits", used_percent: 20, window_minutes: 300, resets_at: NOW_SEC + 3600 },
          { name: "credits_10080", group: "credits", used_percent: 55, window_minutes: 10080, resets_at: NOW_SEC + 86400 },
        ],
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[creditSource]} now={NOW} />);

    expect(screen.getByText("5-hour credits")).toBeInTheDocument();
    expect(screen.getByText("7d credits")).toBeInTheDocument();
    expect(screen.getAllByText("5-hour credits")).toHaveLength(1);
    expect(screen.queryByText("Credit window")).not.toBeInTheDocument();
  });

  it("shows each window's reset time and snapshot age in its tooltip", async () => {
    const user = userEvent.setup();
    renderWithI18n(<SubscriptionQuotaCards sources={[source()]} now={NOW} />);

    await user.hover(chip("5-hour tokens"));
    const reset = await screen.findByText(
      `resets at ${formatQuotaTime(NOW_SEC + 3600, NOW, "Asia/Shanghai", "en")}`,
    );
    expect(reset.closest('[data-slot="tooltip-content"]')).toHaveTextContent("updated 2m ago");
  });

  it("counts a passed reset as refilled and puts the tightest window first", () => {
    const custom = source({
      quota: {
        provider: "glm",
        status: "ok",
        source: "subscription",
        observed_at: NOW_SEC,
        windows: [
          { name: "tokens_300", group: "tokens", used_percent: 95, window_minutes: 300, resets_at: NOW_SEC - 60 },
          { name: "tokens_10080", group: "tokens", used_percent: 60, window_minutes: 10080, resets_at: NOW_SEC + 86400 },
        ],
      },
    });
    const { container } = renderWithI18n(<SubscriptionQuotaCards sources={[custom]} now={NOW} />);
    const triggers = container.querySelectorAll('[data-slot="tooltip-trigger"]');
    expect(triggers[0]).toHaveTextContent("7d tokens40% left");
    expect(screen.getByText("100% left")).toBeInTheDocument();
  });

  it("renders ZenMux windows and an owner-visible collection error", () => {
    const zenmux = source({
      kind: "zenmux",
      name: "Shared ZenMux",
      visibility: "shared",
      last_error: { code: "invalid_credential", message: "provider rejected the key" },
      quota: {
        provider: "zenmux",
        status: "ok",
        source: "subscription",
        observed_at: NOW_SEC,
        windows: [
          { name: "zenmux_5h", group: "zenmux", used_percent: 25, window_minutes: 300, resets_at: null },
          { name: "zenmux_7d", group: "zenmux", used_percent: 80, window_minutes: 10080, resets_at: null },
        ],
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[zenmux]} now={NOW} />);

    expect(screen.getByText("Shared")).toBeInTheDocument();
    expect(screen.getByText("5h subscription")).toBeInTheDocument();
    expect(screen.getByText("7d subscription")).toBeInTheDocument();
    expect(screen.getByText(/The provider rejected this credential/)).toBeInTheDocument();
  });

  it("keeps a stale snapshot visible but marks collection interrupted", () => {
    const stale = source();
    if (stale.quota) stale.quota.observed_at = NOW_SEC - 3601;
    renderWithI18n(<SubscriptionQuotaCards sources={[stale]} now={NOW} />, { locale: "zh-Hans" });

    expect(screen.getByText(/采集中断/)).toBeInTheDocument();
    expect(screen.getAllByText(/剩 \d+%/).length).toBeGreaterThan(0);
  });

  it("renders a DeepSeek money balance with topped-up/granted breakdown in the tooltip", async () => {
    const deepseek = source({
      id: "source-ds",
      kind: "deepseek",
      name: "DeepSeek 充值",
      quota: {
        provider: "deepseek",
        status: "ok",
        source: "subscription",
        observed_at: NOW_SEC - 120,
        available: true,
        windows: [],
        balances: [
          { currency: "CNY", total_balance: 48.5, granted_balance: 0.5, topped_up_balance: 48 },
        ],
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[deepseek]} now={NOW} />);

    expect(screen.getByText("CNY")).toBeInTheDocument();
    expect(screen.getAllByText("Available · balance ¥48.50").length).toBeGreaterThan(0);
    await userEvent.hover(chip("Available · balance ¥48.50"));
    expect(await screen.findByText("Topped-up balance ¥48.00")).toBeInTheDocument();
    expect(screen.getByText("Granted balance ¥0.50")).toBeInTheDocument();
  });

  it("flags an exhausted or unavailable balance destructively", () => {
    const drained = source({
      id: "source-ds2",
      kind: "deepseek",
      name: "Drained",
      quota: {
        provider: "deepseek",
        status: "limited",
        source: "subscription",
        observed_at: NOW_SEC - 120,
        available: false,
        windows: [],
        balances: [{ currency: "CNY", total_balance: -2.5 }],
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[drained]} now={NOW} />);

    const exhaustedPill = screen.getAllByText("Balance exhausted / unavailable")[0];
    expect(exhaustedPill?.parentElement?.className).toContain("text-destructive");
  });

  it("renders the jev_free health probe with latency", () => {
    const free = source({
      id: "source-free",
      kind: "jev_free",
      name: "免费通道",
      quota: {
        provider: "opencode",
        status: "ok",
        source: "subscription",
        observed_at: NOW_SEC - 30,
        available: true,
        windows: [],
        probe: { available: true, latency_ms: 340, model: "jev-1.13-free" },
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[free]} now={NOW} />);

    const pill = screen.getByText("Healthy · 340ms").closest("span")!;
    expect(pill.className).toContain("text-success");
    expect(screen.queryByText("Waiting for the first collection")).not.toBeInTheDocument();
  });

  it("renders a rate-limited jev_free monitor with its error reason and check time", () => {
    const limited = source({
      id: "source-free2",
      kind: "jev_free",
      name: "免费通道",
      quota: null,
      last_polled_at: new Date(NOW - 60_000).toISOString(),
      last_error: { code: "rate_limited", message: "rate_limited (http 429)" },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[limited]} now={NOW} />);

    const pill = screen.getByText("Rate limited").closest("span")!;
    expect(pill.className).toContain("text-warning");
    expect(screen.getByText("The provider is rate limiting requests. Try again later.")).toBeInTheDocument();
  });

  it("renders an enabled source with no snapshot as waiting", () => {
    renderWithI18n(<SubscriptionQuotaCards sources={[source({ quota: null })]} now={NOW} />);
    expect(screen.getByText("Waiting for the first collection")).toBeInTheDocument();
  });
});
