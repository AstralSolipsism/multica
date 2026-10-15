/** Fixed, readable card geometry shared by the worker and canvas. */
export const DAG_NODE_WIDTH = 248;
export const DAG_NODE_HEIGHT = 116;
export const DAG_GROUP_HEADER_HEIGHT = 76;
export const DAG_GROUP_MIN_WIDTH = 680;
export const DAG_GROUP_HEADER_MAX_WIDTH = 680;
export const DAG_STAGE_HEADER_HEIGHT = 38;

// Stage 8 geometry. Change this policy here when adding another direction.
export const DAG_FLOW = { direction: "RIGHT", inputSide: "WEST", outputSide: "EAST" } as const;
export const DAG_OVERVIEW_SIZE = { width: 280, height: 140 } as const;
export const DAG_EXTERNAL_SIZE = { width: 184, height: 76 } as const;
export const DAG_LAYOUT_DEADLINE_MS = 3000;

// Stage 10 motion and zoom policy (OL-183 §4/§7).
/** At most this many segments animate on screen; beyond it only the selected
 *  chain keeps its motion. */
export const DAG_MOTION_MAX_SEGMENTS = 60;
/** Edge motion stops below 50% zoom. */
export const DAG_MOTION_MIN_ZOOM = 0.5;
/** Below this zoom text is unreadable, so cards swap to plain blocks. */
export const DAG_SIMPLIFIED_ZOOM = 0.4;
/** Hysteresis band for leaving the simplified view: zooming in and out
 *  across the threshold would otherwise rebuild every card on each crossing. */
export const DAG_SIMPLIFIED_HYSTERESIS = 0.04;
/** A second single click on the selected node switches to all upstream +
 *  downstream — but only once the system's double-click window has passed,
 *  so a real double-click never triggers the switch (OL-284, 2026-10-15). */
export const DAG_CLICK_CYCLE_MS = 400;
/** Bus hit zones render only when the visible segment count is aimable —
 *  at fully zoomed-out stress views they would cost more than they are worth. */
export const DAG_BUS_HIT_LIMIT = 600;
/** The MiniMap renders one rect per node and re-renders on every viewport
 *  change; past this count it is both illegible and the biggest remaining
 *  frame cost, so it stays off. */
export const DAG_MINIMAP_NODE_LIMIT = 200;
