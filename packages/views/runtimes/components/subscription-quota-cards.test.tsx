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

function card(name: string) {
  return screen.getByText(name).closest<HTMLElement>('[data-slot="tooltip-trigger"]')!;
}

describe("SubscriptionQuotaCards", () => {
  it("renders compact tiles with short windows and drops the duplicated channel, visibility and timestamp noise", () => {
    const { container } = renderWithI18n(<SubscriptionQuotaCards sources={[source()]} now={NOW} />);

    expect(screen.getByText("Primary GLM")).toBeInTheDocument();
    expect(screen.getByText("7d 40%")).toBeInTheDocument();
    expect(screen.getByText("5h 70%")).toBeInTheDocument();
    expect(screen.getByText("Monthly tool credits 84%")).toBeInTheDocument();

    // The icon already names the channel; the type label and the visibility
    // badge were pure noise on the status tiles.
    expect(screen.queryByText("Zhipu GLM Coding Plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    // Last-updated moved into the hover tooltip.
    expect(screen.queryByText(/updated 2m ago/)).not.toBeInTheDocument();

    const region = container.querySelector("section")!;
    expect(region.className).toContain("flex-wrap");
    const tile = card("Primary GLM");
    expect(tile.tagName).toBe("ARTICLE");
    expect(tile.className).toContain("inline-flex");
  });

  it("opens the tile tooltip with full window names, reset time and snapshot age", async () => {
    const user = userEvent.setup();
    renderWithI18n(<SubscriptionQuotaCards sources={[source()]} now={NOW} />);

    await user.hover(card("Primary GLM"));
    expect(await screen.findByText("5-hour tokens · 70% left")).toBeInTheDocument();
    const reset = screen.getByText(
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
    expect(triggers[0]).toHaveTextContent("7d 40%");
    expect(screen.getByText("5h 100%")).toBeInTheDocument();
  });

  it("renders ZenMux windows and a compact error hint without the visibility badge", async () => {
    const user = userEvent.setup();
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

    expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    expect(screen.queryByText("ZenMux")).not.toBeInTheDocument();
    expect(screen.getByText("5h 75%")).toBeInTheDocument();
    expect(screen.getByText("7d 20%")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();

    await user.hover(card("Shared ZenMux"));
    expect(await screen.findByText(/The provider rejected this credential/)).toBeInTheDocument();
  });

  it("keeps a stale snapshot visible but marks collection interrupted", () => {
    const stale = source();
    if (stale.quota) stale.quota.observed_at = NOW_SEC - 3601;
    renderWithI18n(<SubscriptionQuotaCards sources={[stale]} now={NOW} />, { locale: "zh-Hans" });

    expect(screen.getByText(/采集中断/)).toBeInTheDocument();
    expect(screen.getByText("7d 40%")).toBeInTheDocument();
  });

  it("renders a compact DeepSeek money balance and keeps the 30-day spend in the tooltip", async () => {
    const user = userEvent.setup();
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
          { currency: "CNY", total_balance: 48.5, granted_balance: 0.5, topped_up_balance: 48, spend_30d: 14.2 },
        ],
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[deepseek]} now={NOW} />);

    const surface = screen.getByText("¥48.50");
    expect(surface.className).toContain("text-success");
    expect(screen.queryByText(/Available · balance/)).not.toBeInTheDocument();

    await user.hover(card("DeepSeek 充值"));
    expect(await screen.findByText("Available balance ¥48.50")).toBeInTheDocument();
    expect(screen.getByText("Spent in the last 30 days ¥14.20")).toBeInTheDocument();
    expect(screen.getByText("Topped-up balance ¥48.00")).toBeInTheDocument();
    expect(screen.getByText("Granted balance ¥0.50")).toBeInTheDocument();
    expect(screen.getByText("updated 2m ago")).toBeInTheDocument();
  });

  it("flags an exhausted balance destructively and clamps the surface amount", () => {
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

    const pill = screen.getByText("¥0.00 · Balance exhausted");
    expect(pill.className).toContain("text-destructive");
  });

  it("renders the jev_free health probe as a latency pill", async () => {
    const user = userEvent.setup();
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

    const pill = screen.getByText("340ms");
    expect(pill.className).toContain("text-success");
    expect(screen.queryByText("Waiting for the first collection")).not.toBeInTheDocument();

    await user.hover(card("免费通道"));
    expect(await screen.findByText("Healthy · 340ms")).toBeInTheDocument();
  });

  it("never labels an unavailable probe as healthy (402 / Insufficient balance snapshot)", () => {
    const unavailable = source({
      id: "source-free3",
      kind: "jev_free",
      name: "免费通道",
      quota: {
        provider: "opencode",
        status: "limited",
        source: "subscription",
        observed_at: NOW_SEC - 30,
        available: false,
        windows: [],
        probe: { available: false, latency_ms: 210, model: "jev-1.13-free" },
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[unavailable]} now={NOW} />);

    expect(screen.queryByText(/Healthy ·/)).not.toBeInTheDocument();
    const pill = screen.getByText("Abnormal");
    expect(pill.className).toContain("text-destructive");
  });

  it("labels an opencode pay-as-you-go probe exhaustion as balance exhausted", () => {
    const drained = source({
      id: "source-oc",
      kind: "opencode",
      name: "OpenCode",
      quota: {
        provider: "opencode",
        status: "limited",
        source: "subscription",
        observed_at: NOW_SEC - 30,
        available: false,
        windows: [],
        probe: { available: false, latency_ms: 180, model: "jev-1.13" },
      },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[drained]} now={NOW} />);

    const pill = screen.getByText("Balance exhausted / unavailable");
    expect(pill.className).toContain("text-destructive");
  });

  it("renders a rate-limited jev_free monitor compactly", () => {
    const limited = source({
      id: "source-free2",
      kind: "jev_free",
      name: "免费通道",
      quota: null,
      last_polled_at: new Date(NOW - 60_000).toISOString(),
      last_error: { code: "rate_limited", message: "rate_limited (http 429)" },
    });
    renderWithI18n(<SubscriptionQuotaCards sources={[limited]} now={NOW} />);

    const pill = screen.getByText("Rate limited");
    expect(pill.className).toContain("text-warning");
    // One compact hint is enough on the surface; the long reason is in the
    // tooltip only.
    expect(screen.queryByText(/The provider is rate limiting requests/)).not.toBeInTheDocument();
  });

  it("renders an enabled source with no snapshot as waiting", () => {
    renderWithI18n(<SubscriptionQuotaCards sources={[source({ quota: null })]} now={NOW} />);
    expect(screen.getByText("Waiting for the first collection")).toBeInTheDocument();
  });
});
