import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { buildStarMapHierarchy, createDagModelIndex, fitStarMapCamera, starMapMacroBounds } from "@multica/core/issues/dag";
import { renderWithI18n } from "../../test/i18n";
import { graphNode, issueGraph } from "./dag-test-fixtures";
import { starMapScreenRadius } from "@multica/core/issues/dag";
import { StarMapCanvas, drawStarMapMorphNode, starMapCornerRadius, starMapNodeRect, starMapNodeSize, starMapSpriteRect, starMapTimeScaleTarget, type StarMapCanvasProps } from "./star-map-canvas";
import { SPRITE_CORE_RATIO } from "./star-map-sprites";

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

describe("star map sprite outline", () => {
  it("aligns the visible core with the interpolated card outline at the cutoff", () => {
    for (const morph of [0.559, 0.56]) {
      const size = starMapNodeSize(15, { x: 0, y: 0, w: 248, h: 116 }, morph);
      const rect = starMapSpriteRect({ x: 80, y: 60, ...size });
      expect(rect.w * SPRITE_CORE_RATIO).toBeCloseTo(size.w, 10);
      expect(rect.h * SPRITE_CORE_RATIO).toBeCloseTo(size.h, 10);
      expect(rect.x + rect.w * (1 - SPRITE_CORE_RATIO) / 2).toBeCloseTo(80 - size.w / 2, 10);
      expect(rect.y + rect.h * (1 - SPRITE_CORE_RATIO) / 2).toBeCloseTo(60 - size.h / 2, 10);
    }
  });
});

describe("star map corner interpolation", () => {
  it("keeps one rounded-rectangle outline continuous in both directions", () => {
    for (const morph of [0.004, 0.25, 0.5, 0.558, 0.559, 0.56, 0.561, 0.75, 1, 0.75, 0.561, 0.56, 0.559, 0.558, 0.5, 0.25, 0.004]) {
      const size = starMapNodeSize(15, { x: 0, y: 0, w: 248, h: 116 }, morph);
      expect(starMapCornerRadius(15, size.w, size.h, morph)).toBeCloseTo(
        Math.min(Math.min(size.w, size.h) / 2, 15 * (1 - morph) + 7 * morph),
        10,
      );
    }
  });
});

describe("star map morph draw calls", () => {
  it("keeps the base opaque and clips every sprite image to that contour", () => {
    for (const morph of [0.5, 0.559, 0.56, 0.559, 0.5]) {
      const operations: string[] = [];
      const gradient = { addColorStop: vi.fn() };
      const ctx = {
        globalAlpha: 1,
        beginPath: vi.fn(),
        roundRect: vi.fn(() => operations.push("roundRect")),
        createLinearGradient: vi.fn(() => gradient),
        fill: vi.fn(() => operations.push(`fill:${ctx.globalAlpha}`)),
        save: vi.fn(() => operations.push("save")),
        clip: vi.fn(() => operations.push("clip")),
        drawImage: vi.fn(() => operations.push("image")),
        restore: vi.fn(() => operations.push("restore")),
        stroke: vi.fn(() => operations.push("stroke")),
        setLineDash: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
      const size = starMapNodeSize(15, { x: 0, y: 0, w: 248, h: 116 }, morph);
      drawStarMapMorphNode(ctx, {
        rect: starMapNodeRect({ x: 80, y: 60, ...size }),
        radius: 15,
        morph,
        alpha: 1,
        light: false,
        closed: false,
        sprite: document.createElement("canvas"),
        spriteRect: starMapSpriteRect({ x: 80, y: 60, ...size }),
        zoom: 1,
        dashed: false,
      });
      expect(operations[0]).toBe("roundRect");
      expect(operations[1]).toBeDefined();
      expect(Number(operations[1]!.split(":")[1])).toBeGreaterThanOrEqual(0.9);
      const imageIndex = operations.indexOf("image");
      if (imageIndex >= 0) {
        expect(operations[imageIndex - 2]).toBe("roundRect");
        expect(operations[imageIndex - 1]).toBe("clip");
      }
      expect(operations.at(-1)).toBe("stroke");
    }
  });

  it("preserves 18px independent and 24px parent minimum screen diameters", () => {
    const solo = { coreRadius: 14, depth: 0, childrenIds: [] };
    const parent = { coreRadius: 22, depth: 0, childrenIds: ["child"] };
    expect(2 * starMapScreenRadius(solo, 0.3, true) * 0.3).toBeCloseTo(18, 10);
    expect(2 * starMapScreenRadius(parent, 0.3, true) * 0.3).toBeCloseTo(24, 10);
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

describe("star map macro camera", () => {
  it("keeps every independent root inside the fitted viewport for one or four projects", () => {
    for (const projectCount of [1, 4]) {
      const nodes = Array.from({ length: 300 }, (_, index) => graphNode(`solo-${index}`, {
        identifier: `OL-${3000 + index}`,
        projectId: `p${index % projectCount + 1}`,
      }));
      const hierarchy = buildStarMapHierarchy(createDagModelIndex(issueGraph(nodes)), { layout: "constellation", showCompleted: true });
      const camera = fitStarMapCamera(starMapMacroBounds(hierarchy), { width: 1280, height: 720 }, {
        insets: { left: 28, right: 28, top: 64, bottom: 64 }, minZoom: 0.05, maxZoom: 0.45, fill: 0.92,
      });
      let minimumDistance = Infinity;
      for (let left = 0; left < hierarchy.roots.length; left += 1) {
        const root = hierarchy.roots[left]!;
        const x = root.anchor.x * camera.zoom + camera.x;
        const y = root.anchor.y * camera.zoom + camera.y;
        expect(x).toBeGreaterThanOrEqual(28);
        expect(x).toBeLessThanOrEqual(1252);
        expect(y).toBeGreaterThanOrEqual(64);
        expect(y).toBeLessThanOrEqual(656);
        expect(Math.max(root.coreRadius * 2 * camera.zoom, 18)).toBeGreaterThanOrEqual(18);
        for (let right = left + 1; right < hierarchy.roots.length; right += 1) {
          const other = hierarchy.roots[right]!;
          minimumDistance = Math.min(minimumDistance, Math.hypot(root.anchor.x - other.anchor.x, root.anchor.y - other.anchor.y) * camera.zoom);
        }
      }
      expect(minimumDistance).toBeGreaterThanOrEqual(22);
    }
  });
});

describe("star map manual edge interaction", () => {
  it("removes a visible manual edge at the same coordinates where a hidden endpoint cannot write", () => {
    const hierarchy = buildStarMapHierarchy(createDagModelIndex(issueGraph([
      graphNode("root"),
      graphNode("done", { status: "done", statusCategory: "done" }),
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
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const node of [root, done]) {
      const pad = node.domainRadius + 60;
      left = Math.min(left, node.anchor.x - pad);
      right = Math.max(right, node.anchor.x + pad);
      top = Math.min(top, node.anchor.y - pad);
      bottom = Math.max(bottom, node.anchor.y + pad);
    }
    const camera = fitStarMapCamera({ left, right, top, bottom }, { width: 800, height: 600 }, {
      insets: { left: 28, right: 28, top: 64, bottom: 64 }, minZoom: 0.05, maxZoom: 0.45, fill: 0.92,
    });
    const clientX = world.x * camera.zoom + camera.x;
    const clientY = world.y * camera.zoom + camera.y;
    const click = (canvas: HTMLCanvasElement) => {
      fireEvent.pointerDown(canvas, { clientX, clientY, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX, clientY, pointerId: 1, detail: 0 });
    };

    const visible = renderWithI18n(<StarMapCanvas {...props} layers={{ ...layers, completed: true }} />);
    click(visible.container.querySelector("canvas")!);
    expect(onRemoveBlocker).toHaveBeenCalledWith("root", "done");
    visible.unmount();

    const hidden = renderWithI18n(<StarMapCanvas {...props} />);
    click(hidden.container.querySelector("canvas")!);
    expect(onRemoveBlocker).toHaveBeenCalledTimes(1);
    expect(props.onAddBlocker).not.toHaveBeenCalled();
  });
});
