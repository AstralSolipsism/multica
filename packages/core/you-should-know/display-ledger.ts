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
   * Records that `tipId` was shown to `userId` and returns its ordinal among
   * the distinct tips they have seen, assigning the next one the first time.
   * Re-displays of the same tip (rotation coming back to it, re-renders,
   * remounts, reloads) return the ordinal it already has instead of counting
   * again. Call it once the bubble is actually on screen.
   */
  recordDisplay: (userId: string, tipId: string) => number;
}

export type TipDisplayLedger = StoreApi<TipDisplayLedgerState>;

const EMPTY_HISTORY: TipDisplayHistory = { count: 0, ordinals: {} };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Storage is user-editable and survives app versions: keep only well-formed
// entries rather than trusting the blob.
function readHistory(value: unknown): TipDisplayHistory | null {
  if (!isRecord(value) || !isCount(value.count)) return null;
  const ordinals = isRecord(value.ordinals)
    ? Object.fromEntries(
        Object.entries(value.ordinals).filter((entry): entry is [string, number] =>
          isCount(entry[1]),
        ),
      )
    : {};
  return { count: value.count, ordinals };
}

function readUsers(persisted: unknown): Record<string, TipDisplayHistory> {
  const users = isRecord(persisted) ? persisted.users : undefined;
  if (!isRecord(users)) return {};
  const result: Record<string, TipDisplayHistory> = {};
  for (const [userId, value] of Object.entries(users)) {
    const history = readHistory(value);
    if (history) result[userId] = history;
  }
  return result;
}

/**
 * The ordinal `tipId` has in this history, or would get if it were shown
 * next. Lets the bubble lay out its settings hint before the display is
 * recorded — recording waits until the bubble is actually on screen.
 */
export function tipDisplayOrdinal(
  history: TipDisplayHistory | undefined,
  tipId: string,
): number {
  return history?.ordinals[tipId] ?? (history?.count ?? 0) + 1;
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
          const ordinal = tipDisplayOrdinal(history, tipId);
          if (history.ordinals[tipId] !== undefined) return ordinal;

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
