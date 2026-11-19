import { describe, expect, it } from "vitest";
import {
  QuotaSourceSchema,
  QuotaSourceSnapshotSchema,
  WorkspaceQuotaSourceSchema,
} from "./labrastro-quota-schemas";

// The quota_source snapshot schema crosses the API boundary on
// GET /api/me/quota-sources and GET /api/runtimes/quota-sources; these tests
// pin the valid shapes of the OL-1369 payload extensions and the malformed
// ones that must degrade instead of fabricating health data.
describe("QuotaSourceSnapshotSchema", () => {
  it("parses a windows-only (glm/zenmux) snapshot unchanged", () => {
    const parsed = QuotaSourceSnapshotSchema.parse({
      provider: "glm",
      status: "ok",
      observed_at: 1_800_000_000,
      source: "subscription",
      windows: [{ name: "tokens_300", group: "tokens", used_percent: 30, window_minutes: 300 }],
    });
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.balances).toBeUndefined();
    expect(parsed.probe).toBeUndefined();
  });

  it("parses balance and probe payloads", () => {
    const parsed = QuotaSourceSnapshotSchema.parse({
      provider: "deepseek",
      status: "ok",
      observed_at: 1_800_000_000,
      source: "subscription",
      available: true,
      balances: [{ currency: "CNY", total_balance: 48.5, topped_up_balance: 48 }],
      probe: { available: true, latency_ms: 340, model: "jev-1.13-free" },
    });
    expect(parsed.balances?.[0]).toMatchObject({ currency: "CNY", total_balance: 48.5, topped_up_balance: 48 });
    expect(parsed.probe?.latency_ms).toBe(340);
  });

  it("parses the pay-as-you-go last-30-day spend, null when not reported", () => {
    const parsed = QuotaSourceSnapshotSchema.parse({
      provider: "opencode",
      status: "ok",
      observed_at: 1,
      source: "subscription",
      balances: [
        { currency: "USD", total_balance: 27.87, spend_30d: 14.2 },
        { currency: "USD", total_balance: 1, spend_30d: null },
      ],
    });
    expect(parsed.balances?.[0]?.spend_30d).toBe(14.2);
    expect(parsed.balances?.[1]?.spend_30d).toBeNull();
  });

  it("drops a malformed balance entry without losing the rest", () => {
    const parsed = QuotaSourceSnapshotSchema.parse({
      provider: "deepseek",
      status: "ok",
      observed_at: 1,
      source: "subscription",
      balances: [
        { currency: "CNY", total_balance: "not-a-number" },
        { currency: "USD", total_balance: 12.75 },
      ],
    });
    // A balance with no parsable amount keeps its currency and degrades the
    // amounts to null rather than inventing numbers; absent keys stay
    // undefined so "not reported" is distinguishable from a real null.
    expect(parsed.balances?.[0]?.currency).toBe("CNY");
    expect(parsed.balances?.[0]?.total_balance).toBeNull();
    expect(parsed.balances?.[1]).toMatchObject({ currency: "USD", total_balance: 12.75 });
  });

  it("degrades a malformed probe to null instead of a fabricated measurement", () => {
    for (const malformed of [
      { available: "fast", latency_ms: 340 },
      { available: true, latency_ms: "340" },
      { latency_ms: 340 },
      { available: true },
    ]) {
      const parsed = QuotaSourceSnapshotSchema.parse({
        provider: "opencode",
        status: "ok",
        observed_at: 1,
        source: "subscription",
        probe: malformed,
      });
      expect(parsed.probe, JSON.stringify(malformed)).toBeNull();
    }
  });

  it("keeps a null probe null", () => {
    const parsed = QuotaSourceSnapshotSchema.parse({
      provider: "opencode",
      status: "ok",
      observed_at: 1,
      source: "subscription",
      probe: null,
    });
    expect(parsed.probe).toBeNull();
  });
});

describe("QuotaSource schema surfaces", () => {
  it("mounts the snapshot schema on the owner response", () => {
    const parsed = QuotaSourceSchema.parse({
      id: "source-1",
      kind: "jev_free",
      name: "free",
      enabled: true,
      visibility: "private",
      quota: { provider: "opencode", status: "ok", observed_at: 1, source: "subscription", probe: { available: "yes", latency_ms: 5 } },
    });
    expect(parsed.quota?.probe).toBeNull();
  });

  it("parses the opencode query mode and workspace, degrading an unknown mode", () => {
    const parsed = QuotaSourceSchema.parse({
      id: "source-oc",
      kind: "opencode",
      name: "OpenCode",
      enabled: true,
      visibility: "private",
      opencode_mode: "payg",
      workspace_id: "wrk_abc",
    });
    expect(parsed.opencode_mode).toBe("payg");
    expect(parsed.workspace_id).toBe("wrk_abc");

    const legacy = QuotaSourceSchema.parse({
      id: "source-legacy",
      kind: "opencode",
      name: "OpenCode",
      enabled: true,
      visibility: "private",
    });
    expect(legacy.opencode_mode).toBeUndefined();
    expect(legacy.workspace_id).toBeUndefined();

    const unknown = QuotaSourceSchema.parse({
      id: "source-unknown",
      kind: "opencode",
      name: "OpenCode",
      opencode_mode: "something-new",
    });
    expect(unknown.opencode_mode).toBeUndefined();
  });

  it("mounts the snapshot schema on the workspace card response", () => {
    const parsed = WorkspaceQuotaSourceSchema.parse({
      id: "source-1",
      kind: "jev_free",
      name: "free",
      visibility: "shared",
      quota: { provider: "opencode", status: "ok", observed_at: 1, source: "subscription", probe: { available: true, latency_ms: 340 } },
    });
    expect(parsed.quota?.probe?.available).toBe(true);
  });
});
