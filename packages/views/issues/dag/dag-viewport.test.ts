// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Viewport } from "@xyflow/react";
import {
  constrainDagViewport,
  dagViewportTargets,
  dagViewportExtent,
  type DagViewportTarget,
} from "./dag-viewport";

const screen = { width: 900, height: 600 };
const title: DagViewportTarget = { id: "line", x: 28, y: 28, width: 680, height: 76 };
const card: DagViewportTarget = { id: "child", x: 2200, y: 100, width: 248, height: 116 };
function visible(view: Viewport, box: typeof screen, item: DagViewportTarget) {
  const x = item.x * view.zoom + view.x,
    y = item.y * view.zoom + view.y;
  const width = item.width * view.zoom,
    height = item.height * view.zoom;
  const padX = Math.min(24, box.width / 4),
    padY = Math.min(24, box.height / 4);
  return (
    Math.min(x + width, box.width - padX) - Math.max(x, padX) >=
      Math.min(width, box.width - 2 * padX) - 0.01 &&
    Math.min(y + height, box.height - padY) - Math.max(y, padY) >=
      Math.min(height, box.height - 2 * padY) - 0.01
  );
}

describe("DAG viewport content bounds", () => {
  it("keeps partial readable cards in place between stages at high zoom", () => {
    const view = { x: -150, y: 24, zoom: 2 };
    const cards = [
      { id: "a", x: 0, y: 0, width: 248, height: 116 },
      { id: "b", x: 328, y: 0, width: 248, height: 116 },
    ];
    expect(constrainDagViewport(view, screen, cards)).toBe(view);
  });
  it("provides one continuous outer pan range across distant task lines", () => {
    const extent = dagViewportExtent([title, card], screen, 2);
    const minX = screen.width - extent[1][0] * 2,
      maxX = -extent[0][0] * 2;
    for (let x = 0; x >= -4000; x -= 20) expect(x >= minX && x <= maxX).toBe(true);
  });

  it("uses header/card geometry, excluding huge empty group backgrounds", () => {
    const targets = dagViewportTargets({
      positions: { line: { x: 28, y: 28 }, child: { x: 2200, y: 100 } },
      groups: {
        line: { x: 28, y: 28, width: 6000, height: 8000, bands: [], stageConflict: false },
      },
      routes: {},
      ports: {},
    });
    expect(targets).toEqual([title, card]);
  });
  it("keeps a valid reading position unchanged even when the line header is offscreen", () => {
    const view = { x: -2000, y: 20, zoom: 1 };
    expect(constrainDagViewport(view, screen, [title, card])).toBe(view);
  });
  it("brings a folded title back without changing the zoom", () => {
    const view = { x: -776, y: 20, zoom: 1 };
    const next = constrainDagViewport(view, screen, [title]);
    expect(next).toEqual({ x: -4, y: 20, zoom: 1 });
    expect(visible(next, screen, title)).toBe(true);
  });
  it("recovers from an interior empty area, not just outside the global bounding rectangle", () => {
    const far = { ...card, y: 2200 };
    const view = { x: -1100, y: -1100, zoom: 1 };
    const next = constrainDagViewport(view, screen, [title, far]);
    expect(next).not.toEqual(view);
    expect([title, far].some((t) => visible(next, screen, t))).toBe(true);
  });
  it("uses the nearest content rather than jumping to the first task line", () => {
    const far = { ...title, id: "last", y: 4000 };
    const next = constrainDagViewport({ x: 20, y: -5000, zoom: 1 }, screen, [title, far]);
    expect(visible(next, screen, far)).toBe(true);
    expect(visible(next, screen, title)).toBe(false);
  });
  it("prefers the toggled line only when the frame needs recovery", () => {
    const other = { ...title, id: "other", y: 800 };
    const valid = { x: 20, y: 20, zoom: 1 };
    expect(constrainDagViewport(valid, screen, [title, other], "other")).toBe(valid);
    const next = constrainDagViewport({ x: 20, y: -3000, zoom: 1 }, screen, [title, other], "line");
    expect(visible(next, screen, title)).toBe(true);
  });
  it.each([0.08, 0.75, 1, 2])("retains zoom %s at every pan boundary", (zoom) => {
    for (const [x, y] of [
      [1e5, 1e5],
      [-1e5, -1e5],
      [1e5, -1e5],
      [-1e5, 1e5],
    ] as const) {
      const next = constrainDagViewport({ x, y, zoom }, screen, [title, card]);
      expect(next.zoom).toBe(zoom);
      expect([title, card].some((t) => visible(next, screen, t))).toBe(true);
      expect(constrainDagViewport(next, screen, [title, card])).toBe(next);
    }
  });
  it("corrects a restored position for a smaller window", () => {
    const smaller = { width: 420, height: 240 };
    const next = constrainDagViewport({ x: 1000, y: 700, zoom: 0.75 }, smaller, [title]);
    expect(next.zoom).toBe(0.75);
    expect(visible(next, smaller, title)).toBe(true);
  });
  it("handles a viewport smaller than a card without forcing a new zoom", () => {
    const tiny = { width: 24, height: 16 };
    const next = constrainDagViewport({ x: 0, y: 0, zoom: 2 }, tiny, [card]);
    expect(visible(next, tiny, card)).toBe(true);
    expect(Number.isFinite(next.x) && Number.isFinite(next.y)).toBe(true);
    expect(next.zoom).toBe(2);
  });
  it("does not invent content or constrain an unmeasured canvas", () => {
    const view = { x: 10000, y: 10000, zoom: 1 };
    expect(constrainDagViewport(view, screen, [])).toBe(view);
    expect(constrainDagViewport(view, { width: 0, height: 0 }, [title])).toBe(view);
  });
});
