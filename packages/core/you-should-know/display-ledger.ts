import { createStore, type StoreApi } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StorageAdapter } from "../types/storage";
import { defaultStorage } from "../platform/storage";
import { createPersistStorage } from "../platform/persist-storage";

export const TIP_DISPLAY_LEDGER_KEY = "multica:you-should-know:display-ledger";

/**
 * How many recently counted tips keep their ordinal per user. A tip that aged
 * out and shows up again would count as new; with a few tips per run that
 * takes weeks of rotation, so the cap only bounds storage.
 */
const REMEMBERED_TIPS = 100;

/** One user's display history. */
export interface TipDisplayHistory {
  /** Distinct tips counted so far. */
  count: number;
  /** 1-based ordinal of each recently counted tip, by tip id. */
  ordinals: Readonly<Record<string, number>>;
}

export interface TipDisplayLedgerState {
  users: Readonly<Record<string, TipDisplayHistory>>;
  /**
   * The tip's ordinal among the distinct tips shown to `userId`, assigning
   * the next one the first time the tip is seen. Re-displays of the same tip
   * (rotation coming back to it, re-renders, remounts, reloads) return the
   * ordinal it already has instead of counting again.
   */
  recordDisplay: (userId: string, tipId: string) => number;
}

export type TipDisplayLedger = StoreApi<TipDisplayLedgerState>;

const EMPTY_HISTORY: TipDisplayHistory = { count: 0, ordinals: {} };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// Storage is user-editable and survives app versions: keep only well-formed
// entries rather than trusting the blob.
function readUsers(persisted: unknown): Record<string, TipDisplayHistory> {
  const users = (persisted as { users?: unknown } | null)?.users;
  if (typeof users !== "object" || users === null) return {};
  const result: Record<string, TipDisplayHistory> = {};
  for (const [userId, value] of Object.entries(users)) {
    const history = value as Partial<TipDisplayHistory> | null;
    if (!history || !isCount(history.count)) continue;
    const ordinals: Record<string, number> = {};
    if (typeof history.ordinals === "object" && history.ordinals !== null) {
      for (const [tipId, ordinal] of Object.entries(history.ordinals)) {
        if (isCount(ordinal)) ordinals[tipId] = ordinal;
      }
    }
    result[userId] = { count: history.count, ordinals };
  }
  return result;
}

/**
 * Per-user count of You Should Know bubble displays (OL-187 §6, OL-194),
 * persisted through a StorageAdapter. It feeds `shouldShowSettingsHint`:
 * the "you can turn this off in personal settings" line rides on the 1st–3rd
 * and every 10th distinct tip a user sees. Counting distinct tips — not
 * rotation steps — keeps a long run's carousel from re-triggering the hint
 * every ten bubbles.
 */
export function createTipDisplayLedger(storage: StorageAdapter): TipDisplayLedger {
  return createStore<TipDisplayLedgerState>()(
    persist(
      (set, get) => ({
        users: {},
        recordDisplay: (userId, tipId) => {
          const history = get().users[userId] ?? EMPTY_HISTORY;
          const known = history.ordinals[tipId];
          if (known !== undefined) return known;

          const ordinal = history.count + 1;
          // Oldest ordinals age out first.
          const kept = Object.entries(history.ordinals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, REMEMBERED_TIPS - 1);
          set((state) => ({
            users: {
              ...state.users,
              [userId]: {
                count: ordinal,
                ordinals: { ...Object.fromEntries(kept), [tipId]: ordinal },
              },
            },
          }));
          return ordinal;
        },
      }),
      {
        name: TIP_DISPLAY_LEDGER_KEY,
        version: 1,
        storage: createJSONStorage(() => createPersistStorage(storage)),
        partialize: (state) => ({ users: state.users }),
        merge: (persisted, current) => ({ ...current, users: readUsers(persisted) }),
      },
    ),
  );
}

/** App-wide ledger on the default (localStorage-backed) adapter. */
export const tipDisplayLedger = createTipDisplayLedger(defaultStorage);
