import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { buildStarMapHierarchy, createDagModelIndex, fitStarMapCamera } from "@multica/core/issues/dag";
import { renderWithI18n } from "../../test/i18n";
import { graphNode, issueGraph } from "./dag-test-fixtures";
import { StarMapCanvas, starMapNodeRect, starMapNodeSize, starMapTimeScaleTarget, type StarMapCanvasProps } from "./star-map-canvas";

const layers = { completed: false, manual: true, wakeup: true, mention: true, stage: true };

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  Object.defineProperties(HTMLCanvasElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("star map node morph geometry", () => {
  it("uses the same interpolated rectangle on both sides of the sprite/card cutoff", () => {
    const target = { x: 0, y: 0, w: 248, h: 116 };
    const rectAt = (morph: number) => starMapNodeRect({ x: 80, y: 60, ...starMapNodeSize(12, target, morph) });
    for (const morph of [0, 0.25, 0.5, 0.559, 0.56, 0.75, 1, 0.75, 0.56, 0.559, 0.5, 0.25, 0]) {
      const rect = rectAt(morph);
      expect(rect.x).toBeCloseTo(80 - (24 + 224 * morph) / 2, 10);
      expect(rect.y).toBeCloseTo(60 - (24 + 92 * morph) / 2, 10);
      expect(rect.w).toBeCloseTo(24 + 224 * morph, 10);
      expect(rect.h).toBeCloseTo(24 + 92 * morph, 10);
    }
  });
});

describe("star map orbital motion", () => {
  it("stops for pause and reduced motion, while hover only slows it", () => {
    expect(starMapTimeScaleTarget(false, false, false, 0)).toBe(0);
    expect(starMapTimeScaleTarget(true, true, false, 0)).toBe(0);
    expect(starMapTimeScaleTarget(true, false, true, 0)).toBe(0.08);
    expect(starMapTimeScaleTarget(true, false, false, 0.25)).toBe(0.75);
  });
});

describe("star map manual edge interaction", () => {
  it("does not reach the blocker removal write through a hidden completed endpoint", () => {
    const hierarchy = buildStarMapHierarchy(createDagModelIndex(issueGraph([
      graphNode("root"),
      graphNode("done", { parentIssueId: "root", status: "done", statusCategory: "completed" }),
    ], [{ id: "manual:root:done", source: "root", target: "done" }])), {
      layout: "constellation",
      showCompleted: true,
    });
    const onRemoveBlocker = vi.fn();
    const props: StarMapCanvasProps = {
      hierarchy,
      target: null,
      phase: "orbital",
      layers,
      layout: "cluster",
      intent: "line",
      orbiting: true,
      linking: false,
      light: false,
      peekOpen: false,
      reducedMotion: false,
      initialCamera: null,
      locateRequest: null,
      scaleCommand: null,
      onRequestScene: vi.fn(),
      onMorphComplete: vi.fn(),
      onExitToOrbit: vi.fn(),
      onOpenIssue: vi.fn(),
      onAddBlocker: vi.fn(),
      onRemoveBlocker,
    };
    const { container } = renderWithI18n(<StarMapCanvas {...props} />);
    const canvas = container.querySelector("canvas")!;
    const root = hierarchy.nodeById.get("root")!;
    const done = hierarchy.nodeById.get("done")!;
    const edge = hierarchy.edges[0]!;
    const a = root.anchor, b = done.anchor;
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    let hash = 0;
    for (let i = 0; i < edge.id.length; i++) hash = (hash * 33 + edge.id.charCodeAt(i)) | 0;
    const bend = Math.min(90, length * 0.12) * (hash % 2 ? 1 : -1);
    const control = { x: (a.x + b.x) / 2 - dy / length * bend, y: (a.y + b.y) / 2 + dx / length * bend };
    const t = 5 / 11, u = 1 - t;
    const world = {
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    };
    const pad = root.domainRadius + 60;
    const camera = fitStarMapCamera({
      left: root.anchor.x - pad,
      right: root.anchor.x + pad,
      top: root.anchor.y - pad,
      bottom: root.anchor.y + pad,
    }, { width: 800, height: 600 }, {
      insets: { left: 28, right: 28, top: 64, bottom: 64 }, minZoom: 0.12, maxZoom: 0.45, fill: 0.92,
    });
    const clientX = world.x * camera.zoom + camera.x;
    const clientY = world.y * camera.zoom + camera.y;

    fireEvent.pointerDown(canvas, { clientX, clientY, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX, clientY, pointerId: 1, detail: 0 });

    expect(onRemoveBlocker).not.toHaveBeenCalled();
    expect(props.onAddBlocker).not.toHaveBeenCalled();
  });
});
