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
  register: (anchor: {
    id: string;
    descriptor: TipAnchorDescriptor;
    top: number;
  }) => void;
  /** Update an anchor's viewport visibility and page position. */
  setAnchorGeometry: (
    id: string,
    geometry: { visible: boolean; top: number },
  ) => void;
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
    register: ({ id, descriptor, top }) => {
      const existing = get().anchors[id];
      // Re-registration with identical content (e.g. StrictMode remount
      // replays) must not notify subscribers.
      if (
        existing &&
        tipAnchorDescriptorKey(existing.descriptor) ===
          tipAnchorDescriptorKey(descriptor) &&
        existing.top === top
      ) {
        return;
      }
      set((s) => ({
        anchors: {
          ...s.anchors,
          // Preserve live geometry across a same-id re-register.
          [id]: {
            id,
            descriptor,
            top,
            visible: existing?.visible ?? false,
          },
        },
      }));
    },
    setAnchorGeometry: (id, { visible, top }) => {
      const existing = get().anchors[id];
      if (!existing || (existing.visible === visible && existing.top === top))
        return;
      set((s) => ({
        anchors: { ...s.anchors, [id]: { ...existing, visible, top } },
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
