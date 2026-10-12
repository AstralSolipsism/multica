// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../types/storage";
import {
  createTipDisplayLedger,
  TIP_DISPLAY_LEDGER_KEY,
  tipDisplayOrdinal,
} from "./display-ledger";

function memoryStorage(initial: Record<string, string> = {}): StorageAdapter & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("tip display ledger", () => {
  it("counts each distinct tip once per user", () => {
    const ledger = createTipDisplayLedger(memoryStorage());
    const { recordDisplay } = ledger.getState();
    expect(recordDisplay("u1", "tip-a")).toBe(1);
    expect(recordDisplay("u1", "tip-b")).toBe(2);
    // Rotation coming back to a tip is not a new display.
    expect(recordDisplay("u1", "tip-a")).toBe(1);
    expect(recordDisplay("u1", "tip-c")).toBe(3);
    expect(ledger.getState().users["u1"]!.count).toBe(3);
  });

  it("peeks the ordinal a tip would get without recording it", () => {
    const ledger = createTipDisplayLedger(memoryStorage());
    expect(tipDisplayOrdinal(undefined, "tip-a")).toBe(1);
    ledger.getState().recordDisplay("u1", "tip-a");
    const history = ledger.getState().users["u1"];
    // Known tips keep theirs; an unseen tip would be next.
    expect(tipDisplayOrdinal(history, "tip-a")).toBe(1);
    expect(tipDisplayOrdinal(history, "tip-b")).toBe(2);
    expect(ledger.getState().users["u1"]!.count).toBe(1);
    // Recording then assigns exactly the peeked ordinal.
    expect(ledger.getState().recordDisplay("u1", "tip-b")).toBe(2);
  });

  it("keeps separate counts per user", () => {
    const ledger = createTipDisplayLedger(memoryStorage());
    const { recordDisplay } = ledger.getState();
    recordDisplay("u1", "tip-a");
    recordDisplay("u1", "tip-b");
    expect(recordDisplay("u2", "tip-a")).toBe(1);
  });

  it("persists through the storage adapter across instances", () => {
    const storage = memoryStorage();
    createTipDisplayLedger(storage).getState().recordDisplay("u1", "tip-a");
    expect(storage.values.has(TIP_DISPLAY_LEDGER_KEY)).toBe(true);

    // A reload: a fresh store over the same storage continues the count and
    // still recognizes the tip it already counted.
    const reloaded = createTipDisplayLedger(storage).getState();
    expect(reloaded.recordDisplay("u1", "tip-a")).toBe(1);
    expect(reloaded.recordDisplay("u1", "tip-b")).toBe(2);
  });

  it("bounds the remembered tips, keeping the count going", () => {
    const ledger = createTipDisplayLedger(memoryStorage());
    const { recordDisplay } = ledger.getState();
    for (let i = 1; i <= 101; i += 1) recordDisplay("u1", `tip-${i}`);
    const history = ledger.getState().users["u1"]!;
    expect(history.count).toBe(101);
    expect(Object.keys(history.ordinals)).toHaveLength(100);
    // The oldest tip aged out; the newest are still recognized.
    expect(history.ordinals["tip-1"]).toBeUndefined();
    expect(recordDisplay("u1", "tip-101")).toBe(101);
  });

  it("ignores malformed persisted entries instead of crashing", () => {
    const storage = memoryStorage({
      [TIP_DISPLAY_LEDGER_KEY]: JSON.stringify({
        state: {
          users: {
            u1: { count: 4, ordinals: { "tip-a": 4, "tip-bad": "x" } },
            u2: { count: "nope" },
            u3: null,
          },
        },
        version: 1,
      }),
    });
    const ledger = createTipDisplayLedger(storage);
    expect(ledger.getState().users).toEqual({
      u1: { count: 4, ordinals: { "tip-a": 4 } },
    });
    expect(ledger.getState().recordDisplay("u1", "tip-b")).toBe(5);
    expect(ledger.getState().recordDisplay("u2", "tip-a")).toBe(1);
  });
});
