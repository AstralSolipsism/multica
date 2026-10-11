import { createStore, type StoreApi } from "zustand/vanilla";
import { tipAnchorDescriptorKey } from "./descriptor";
import type {
  RegisteredTipAnchor,
  TipAnchorDescriptor,
  TipAnchorDisplayState,
} from "./types";

export interface TipAnchorRegistryState {
  /** Mounted anchors by id, in registration (≈ mount) order. */
  anchors: Record<string, RegisteredTipAnchor>;
  /** Display state the page-level provider writes back after scheduling. */
  display: TipAnchorDisplayState;
  /**
   * Register an anchor, or update an existing one's descriptor/measure in
   * place. Re-registering an id keeps its visibility and never touches the
   * display state — a descriptor change (e.g. a summary scope growing by one
   * issue) must not interrupt the bubble or clear dots.
   */
  register: (anchor: {
    id: string;
    descriptor: TipAnchorDescriptor;
    measure: () => number;
  }) => void;
  /** Update an anchor's viewport visibility. */
  setAnchorVisible: (id: string, visible: boolean) => void;
  unregister: (id: string) => void;
  setDisplay: (display: TipAnchorDisplayState) => void;
}

export type TipAnchorRegistry = StoreApi<TipAnchorRegistryState>;

const INITIAL_DISPLAY: TipAnchorDisplayState = {
  bubbleAnchorId: null,
  dotAnchorIds: [],
};

function sameDisplay(a: TipAnchorDisplayState, b: TipAnchorDisplayState): boolean {
  return (
    a.bubbleAnchorId === b.bubbleAnchorId &&
    a.dotAnchorIds.length === b.dotAnchorIds.length &&
    a.dotAnchorIds.every((id, i) => id === b.dotAnchorIds[i])
  );
}

/**
 * Per-page registry of tip anchors (OL-193). The provider creates one
 * instance per page and hands it down through context; anchors register on
 * mount and unregister on unmount (virtualized rows drop out by themselves).
 *
 * The registry also holds the provider's write-back display state, so each
 * anchor can subscribe to just its own slice ("do I show a dot?") with a
 * primitive selector — no per-anchor re-render storms when scheduling runs.
 */
export function createTipAnchorRegistry(): TipAnchorRegistry {
  return createStore<TipAnchorRegistryState>()((set, get) => ({
    anchors: {},
    display: INITIAL_DISPLAY,
    register: ({ id, descriptor, measure }) => {
      const existing = get().anchors[id];
      if (existing) {
        // Identical re-registration (StrictMode replays, effect re-runs)
        // must not notify subscribers.
        if (
          tipAnchorDescriptorKey(existing.descriptor) ===
            tipAnchorDescriptorKey(descriptor) &&
          existing.measure === measure
        ) {
          return;
        }
        // In-place update: keep visibility, keep display references.
        set((s) => ({
          anchors: {
            ...s.anchors,
            [id]: { ...existing, descriptor, measure },
          },
        }));
        return;
      }
      set((s) => ({
        anchors: {
          ...s.anchors,
          [id]: { id, descriptor, measure, visible: false },
        },
      }));
    },
    setAnchorVisible: (id, visible) => {
      const existing = get().anchors[id];
      if (!existing || existing.visible === visible) return;
      set((s) => ({
        anchors: { ...s.anchors, [id]: { ...existing, visible } },
      }));
    },
    unregister: (id) => {
      if (!get().anchors[id]) return;
      set((s) => {
        const { [id]: _, ...anchors } = s.anchors;
        // Drop dangling display references so a gone anchor never keeps a
        // bubble slot or a dot it can no longer render.
        const display: TipAnchorDisplayState = {
          bubbleAnchorId:
            s.display.bubbleAnchorId === id ? null : s.display.bubbleAnchorId,
          dotAnchorIds: s.display.dotAnchorIds.includes(id)
            ? s.display.dotAnchorIds.filter((dotId) => dotId !== id)
            : s.display.dotAnchorIds,
        };
        return {
          anchors,
          display: sameDisplay(display, s.display) ? s.display : display,
        };
      });
    },
    setDisplay: (display) => {
      if (sameDisplay(display, get().display)) return;
      set({ display });
    },
  }));
}
