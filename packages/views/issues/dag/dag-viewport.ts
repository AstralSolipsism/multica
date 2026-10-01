import type { CoordinateExtent, Rect, Viewport } from "@xyflow/react";
import type { DagLayoutResult } from "./dag-layout";
import {
  DAG_NODE_WIDTH,
  DAG_NODE_HEIGHT,
  DAG_GROUP_HEADER_HEIGHT,
  DAG_GROUP_HEADER_MAX_WIDTH,
} from "./dag-constants";

export type DagViewportTarget = Rect & { id: string };

/** Empty group backgrounds and dependency routes are not navigation anchors. */
export function dagViewportTargets(layout: DagLayoutResult): DagViewportTarget[] {
  return Object.entries(layout.positions).map(([id, position]) => {
    const group = layout.groups[id];
    const size = group
      ? {
          width: Math.min(group.width, DAG_GROUP_HEADER_MAX_WIDTH),
          height: DAG_GROUP_HEADER_HEIGHT,
        }
      : { width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT };
    return { id, ...position, ...size };
  });
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
