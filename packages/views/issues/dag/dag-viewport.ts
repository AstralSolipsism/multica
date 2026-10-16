import type { CoordinateExtent, Rect, Viewport } from "@xyflow/react";
import {
  DAG_FIRST_OPEN_ZOOM,
  DAG_FIT_VIEW_PADDING,
  DAG_GROUP_HEADER_HEIGHT,
  DAG_GROUP_HEADER_MAX_WIDTH,
} from "./dag-constants";
import type { DagSceneGeometry } from "./dag-scene";

export type DagViewportTarget = Rect & { id: string };

/** Cards anchor on their full box, frames on their header: the empty body and
 * dependency routes are not navigation anchors. */
export function dagViewportTargets(
  geometry: DagSceneGeometry,
  frameHeaderWidth = DAG_GROUP_HEADER_MAX_WIDTH,
): DagViewportTarget[] {
  return [
    ...Object.entries(geometry.nodes).map(([id, box]) => ({ id, ...box })),
    ...Object.entries(geometry.frames).map(([id, box]) => ({
      id,
      x: box.x,
      y: box.y,
      width: Math.min(box.width, frameHeaderWidth),
      height: DAG_GROUP_HEADER_HEIGHT,
    })),
  ];
}

/** A single outer rectangle leaves every path between task lines traversable. */
export function dagViewportExtent(
  targets: readonly DagViewportTarget[],
  size: { width: number; height: number },
  zoom: number,
): CoordinateExtent {
  if (!targets.length || size.width <= 0 || size.height <= 0)
    return [
      [-Infinity, -Infinity],
      [Infinity, Infinity],
    ];
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const target of targets) {
    left = Math.min(left, target.x);
    top = Math.min(top, target.y);
    right = Math.max(right, target.x + target.width);
    bottom = Math.max(bottom, target.y + target.height);
  }
  const keepX = Math.min(64, size.width / 4, (right - left) * zoom);
  const keepY = Math.min(64, size.height / 4, (bottom - top) * zoom);
  const padX = (size.width - keepX) / zoom,
    padY = (size.height - keepY) / zoom;
  return [
    [left - padX, top - padY],
    [right + padX, bottom + padY],
  ];
}

export function sameDagViewport(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && a.zoom === b.zoom;
}

/** The rectangle fitView sees: every card and frame box, frames whole (they
 *  are React Flow nodes too). */
export function dagSceneContentBounds(geometry: DagSceneGeometry): Rect | null {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  let found = false;
  for (const boxes of [geometry.nodes, geometry.frames]) {
    for (const box of Object.values(boxes)) {
      found = true;
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
  }
  return found
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/** How a first-opened scene anchors when it no longer fits one screen: the
 *  overview starts at its top-left corner (reading order); a line or focus
 *  scene starts at its leftmost column and centers the cross axis when that
 *  still fits. */
export type DagFirstOpenAnchor = "start" | "flow";

/**
 * First-open viewport for a level with no saved viewport. Returns null when
 * the scene fits at the readable zoom — the caller then keeps its historical
 * fitView (padding DAG_FIT_VIEW_PADDING, maxZoom 1), which lands at or above
 * the readable zoom. Otherwise the scene opens at the readable zoom anchored
 * at its start, so a large scene's first paint never drops to the unreadable
 * simplified blocks (OL-451).
 */
export function dagFirstOpenViewport(
  bounds: Rect | null,
  size: { width: number; height: number },
  anchor: DagFirstOpenAnchor,
  zoom = DAG_FIRST_OPEN_ZOOM,
  margin = 24,
): Viewport | null {
  if (!bounds || size.width <= 0 || size.height <= 0 || bounds.width <= 0 || bounds.height <= 0)
    return null;
  // Mirrors xyflow's scalar fitView padding: with padding p the fit zoom is
  // min((width - 2*px)/bounds.width, (height - 2*py)/bounds.height) where
  // px = floor((width - width/(1+p))/2). The caller's fitView then reaches at
  // least the readable zoom exactly when this verdict says the scene fits.
  const padX = Math.floor((size.width - size.width / (1 + DAG_FIT_VIEW_PADDING)) * 0.5);
  const padY = Math.floor((size.height - size.height / (1 + DAG_FIT_VIEW_PADDING)) * 0.5);
  const fitZoom = Math.min(
    (size.width - 2 * padX) / bounds.width,
    (size.height - 2 * padY) / bounds.height,
  );
  if (fitZoom >= zoom) return null;
  const x = margin - bounds.x * zoom;
  const y =
    anchor === "flow" && bounds.height * zoom <= size.height - 2 * margin
      ? size.height / 2 - (bounds.y + bounds.height / 2) * zoom
      : margin - bounds.y * zoom;
  return { x, y, zoom };
}

/** Translate by the shortest distance that keeps a content item readable.
 * Large items may fill the available viewport; this never changes the zoom. */
export function constrainDagViewport(
  viewport: Viewport,
  size: { width: number; height: number },
  targets: readonly DagViewportTarget[],
  preferredId?: string,
): Viewport {
  if (size.width <= 0 || size.height <= 0 || !targets.length) return viewport;
  const padX = Math.min(24, size.width / 4);
  const padY = Math.min(24, size.height / 4);
  let closest = viewport;
  let distance = Infinity;
  let preferred: Viewport | undefined;
  for (const target of targets) {
    const left = target.x * viewport.zoom;
    const top = target.y * viewport.zoom;
    const width = target.width * viewport.zoom;
    const height = target.height * viewport.zoom;
    const readableWidth = Math.min(160, width, (size.width - 2 * padX) / 4);
    const readableHeight = Math.min(64, height, (size.height - 2 * padY) / 4);
    const shownWidth =
      Math.min(left + viewport.x + width, size.width - padX) - Math.max(left + viewport.x, padX);
    const shownHeight =
      Math.min(top + viewport.y + height, size.height - padY) - Math.max(top + viewport.y, padY);
    if (shownWidth >= readableWidth - 0.01 && shownHeight >= readableHeight - 0.01) return viewport;
    const visibleWidth = Math.min(width, size.width - 2 * padX);
    const visibleHeight = Math.min(height, size.height - 2 * padY);
    const candidate = {
      x: Math.max(
        padX + visibleWidth - left - width,
        Math.min(size.width - padX - visibleWidth - left, viewport.x),
      ),
      y: Math.max(
        padY + visibleHeight - top - height,
        Math.min(size.height - padY - visibleHeight - top, viewport.y),
      ),
      zoom: viewport.zoom,
    };
    if (sameDagViewport(candidate, viewport)) return viewport;
    if (target.id === preferredId) preferred = candidate;
    const movement = (candidate.x - viewport.x) ** 2 + (candidate.y - viewport.y) ** 2;
    if (movement < distance) {
      distance = movement;
      closest = candidate;
    }
  }
  return preferred ?? closest;
}
