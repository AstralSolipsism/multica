// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDagModelIndex } from "./model-index";
import { graphNode as n, issueGraph as g } from "./test-fixtures";
import {
  buildStarMapHierarchy, clampStarMapCamera, fitStarMapCamera,
  nearestStarMapNode, starMapMacroBounds, starMapMorphAt, starMapScreenRadius,
} from "./star-map";

const done = { status: "done", statusCategory: "done" };

function hierarchyFixture() {
  return g([
    n("root", { projectId: "p1" }),
    n("later", { parentIssueId: "root", stage: 2 }),
    n("leaf", { parentIssueId: "later", stage: 1 }),
    n("first", { parentIssueId: "root", stage: 1 }),
    n("finished", { ...done }), n("finished-child", { parentIssueId: "finished", ...done }),
    n("done-parent", { ...done, projectId: "p2" }), n("live-child", { parentIssueId: "done-parent" }),
    n("solo"),
  ], [
    { id: "manual:first:solo", source: "first", target: "solo" },
    { id: "stage:first:solo", source: "first", target: "solo" },
  ], [
    { from: "solo", to: "first", kind: "wakeup", untilState: "done" },
    { from: "root", to: "solo", kind: "mention" },
    { from: "solo", to: "root", kind: "mention" },
  ]);
}

describe("star map hierarchy", () => {
  it("contains arbitrary-depth child systems, sorts stages, and preserves active completed roots", () => {
    const index = createDagModelIndex(hierarchyFixture());
    const model = buildStarMapHierarchy(index, { layout: "constellation", showCompleted: false });
    const root = model.nodeById.get("root")!, later = model.nodeById.get("later")!, leaf = model.nodeById.get("leaf")!;
    expect(root.children.map((node) => node.id)).toEqual(["first", "later"]);
    expect(later.children.map((node) => node.id)).toEqual(["leaf"]);
    expect(leaf.orbitRadius + leaf.domainRadius).toBeLessThanOrEqual(later.domainRadius);
    expect(later.orbitRadius + later.domainRadius).toBeLessThanOrEqual(root.domainRadius);
    expect(model.nodeById.has("finished")).toBe(false);
    expect(model.nodeById.has("finished-child")).toBe(false);
    expect(model.nodeById.has("done-parent")).toBe(true);
    expect(model.nodeById.get("done-parent")?.activeDescendants).toBe(1);
    expect(model.nodeById.get("solo")).toMatchObject({ rootId: "solo", parentId: null, depth: 0 });
    expect(buildStarMapHierarchy(index, { layout: "constellation", showCompleted: true }).nodeById.has("finished")).toBe(true);

    expect(model.edges.map((edge) => [edge.kind, edge.source, edge.target])).toEqual([
      ["manual", "first", "solo"], ["wakeup", "solo", "first"],
      ["mention", "root", "solo"], ["mention", "solo", "root"],
    ]);
    expect(model.edges.filter((edge) => edge.kind === "mention").every((edge) => edge.mutual)).toBe(true);
  });

  it("is deterministic in both layouts without sharing mutable anchors", () => {
    const index = createDagModelIndex(hierarchyFixture());
    const options = { layout: "constellation", showCompleted: false } as const;
    const first = buildStarMapHierarchy(index, options);
    const second = buildStarMapHierarchy(index, options);
    const anchors = (model: typeof first) => model.roots.map((root) => [root.id, root.anchor]);
    expect(anchors(first)).toEqual(anchors(second));
    expect(first.sectorGuides).toEqual(second.sectorGuides);
    const polar = buildStarMapHierarchy(index, { layout: "polar", showCompleted: false });
    expect(anchors(polar)).not.toEqual(anchors(first));
    expect(polar.roots.map((root) => root.id).sort()).toEqual(first.roots.map((root) => root.id).sort());
    expect(Object.isFrozen(first.nodeById.get("root"))).toBe(true);
    expect(Object.isFrozen(first.nodeById.get("root")?.anchor)).toBe(true);
  });

  it.each(["constellation", "polar"] as const)("spaces 300 independent roots across bounded rings in %s layout", (layout) => {
    const graph = g(Array.from({ length: 300 }, (_, index) =>
      n(`task-${String(index).padStart(3, "0")}`, { projectId: "p1" })));
    const options = { layout, showCompleted: false };
    const first = buildStarMapHierarchy(createDagModelIndex(graph), options);
    const second = buildStarMapHierarchy(createDagModelIndex(graph), options);
    expect(second.roots.map((root) => [root.id, root.anchor])).toEqual(first.roots.map((root) => [root.id, root.anchor]));
    expect(second.sectorGuides).toEqual(first.sectorGuides);
    expect(new Set(first.roots.map((root) => `${root.anchor.x},${root.anchor.y}`)).size).toBe(300);

    const innerRing = first.roots.filter((root) => Math.abs(Math.hypot(root.anchor.x, root.anchor.y) - 76) < 1e-9);
    expect(innerRing).toHaveLength(6);
    const innerAngles = innerRing.map((root) => Math.atan2(root.anchor.y, root.anchor.x)).sort((a, b) => a - b);
    const angularGaps = innerAngles.map((angle, index) =>
      (innerAngles[(index + 1) % innerAngles.length]! + (index === innerAngles.length - 1 ? Math.PI * 2 : 0)) - angle);
    expect(Math.max(...angularGaps)).toBeCloseTo(Math.PI / 3);

    let minimumDistance = Infinity;
    for (let left = 0; left < first.roots.length; left += 1) {
      for (let right = left + 1; right < first.roots.length; right += 1) {
        const a = first.roots[left]!.anchor, b = first.roots[right]!.anchor;
        minimumDistance = Math.min(minimumDistance, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(minimumDistance * 0.45).toBeGreaterThanOrEqual(18);

    expect(first.sectorGuides).toHaveLength(1);
    const guide = first.sectorGuides[0]!;
    for (const root of first.roots) {
      if (guide.kind === "cluster") {
        const distance = Math.hypot(root.anchor.x - guide.cx, root.anchor.y - guide.cy);
        expect(distance + root.coreRadius).toBeLessThanOrEqual(guide.radius);
      } else {
        const radius = Math.hypot(root.anchor.x, root.anchor.y);
        const angle = (Math.atan2(root.anchor.y, root.anchor.x) - guide.start + Math.PI * 2) % (Math.PI * 2);
        const angularRadius = Math.asin(root.coreRadius / radius);
        expect(radius - root.coreRadius).toBeGreaterThanOrEqual(guide.innerR);
        expect(radius + root.coreRadius).toBeLessThanOrEqual(guide.outerR);
        expect(angle).toBeGreaterThanOrEqual(angularRadius);
        expect(angle).toBeLessThanOrEqual(guide.end - guide.start - angularRadius);
      }
    }
  });

  it.each(["constellation", "polar"] as const)("fits the independent and parent root matrix in %s layout", (layout) => {
    const size = { width: 1280, height: 720 };
    const insets = { left: 28, right: 28, top: 64, bottom: 64 };
    for (const projectCount of [1, 4]) {
      for (const kind of ["independent", "parents"] as const) {
        const rootCount = kind === "independent" ? 300 : 150;
        const nodes = Array.from({ length: rootCount }, (_, index) => {
          const id = `${kind}-${index}`, projectId = `p${index % projectCount + 1}`;
          return kind === "independent" ? [n(id, { projectId })] : [
            n(id, { projectId }), n(`${id}-child`, { projectId, parentIssueId: id }),
          ];
        }).flat();
        const graph = g(nodes);
        graph.projects = Array.from({ length: projectCount }, (_, index) => ({ id: `p${index + 1}`, title: `Project ${index + 1}` }));
        const hierarchy = buildStarMapHierarchy(createDagModelIndex(graph), { layout, showCompleted: false });
        const camera = fitStarMapCamera(starMapMacroBounds(hierarchy), size, {
          insets, minZoom: 0.05, maxZoom: 4, fill: 0.92,
        });
        let outside = 0, minimumDistance = Infinity, maximumRadius = 0;
        for (let left = 0; left < hierarchy.roots.length; left += 1) {
          const root = hierarchy.roots[left]!, a = root.anchor;
          const x = a.x * camera.zoom + camera.x, y = a.y * camera.zoom + camera.y;
          const rPx = starMapScreenRadius(root, camera.zoom, true) * camera.zoom;
          maximumRadius = Math.max(maximumRadius, rPx);
          if (x - rPx < insets.left || x + rPx > size.width - insets.right ||
            y - rPx < insets.top || y + rPx > size.height - insets.bottom) outside += 1;
          expect(rPx * 2).toBeGreaterThanOrEqual(18);
          for (let right = left + 1; right < hierarchy.roots.length; right += 1) {
            const b = hierarchy.roots[right]!.anchor;
            minimumDistance = Math.min(minimumDistance, Math.hypot(a.x - b.x, a.y - b.y) * camera.zoom);
          }
        }
        expect(outside).toBe(0);
        if (kind === "independent") expect(minimumDistance).toBeGreaterThanOrEqual(22);
        else expect(minimumDistance).toBeGreaterThan(maximumRadius * 2);
      }
    }
  });
});

describe("star map interaction", () => {
  it("prefers a directly hit deeper node, then weighted parent-domain capture", () => {
    const model = buildStarMapHierarchy(createDagModelIndex(hierarchyFixture()), { layout: "polar", showCompleted: false });
    const root = model.nodeById.get("root")!, leaf = model.nodeById.get("leaf")!, solo = model.nodeById.get("solo")!;
    const overlapping = new Map([[root.id, { x: 0, y: 0 }], [leaf.id, { x: 0, y: 0 }]]);
    expect(nearestStarMapNode(model.nodes, overlapping, { x: 0, y: 0 }, 1)).toMatchObject({
      node: { id: "leaf" }, root: { id: "root" }, distance: 0,
    });
    const capture = new Map([[root.id, { x: 0, y: 0 }], [solo.id, { x: 90, y: 0 }]]);
    expect(nearestStarMapNode([root, solo], capture, { x: 50, y: 0 }, 1)?.node.id).toBe("root");
    expect(nearestStarMapNode(model.nodes, new Map(), { x: 0, y: 0 }, 1)).toBeNull();
  });

  it("fits and exactly centers all bounds in the inset viewport", () => {
    const camera = fitStarMapCamera(
      { left: -100, top: -50, right: 300, bottom: 150 },
      { width: 1000, height: 800 },
      { insets: { left: 20, right: 300, top: 40, bottom: 60 }, minZoom: 0.05, maxZoom: 10 },
    );
    expect(camera).toEqual({ x: 190, y: 305, zoom: 1.7 });
    expect(-100 * camera.zoom + camera.x).toBe(20);
    expect(300 * camera.zoom + camera.x).toBe(700);
    expect(-50 * camera.zoom + camera.y).toBeGreaterThanOrEqual(40);
    expect(150 * camera.zoom + camera.y).toBeLessThanOrEqual(740);
  });

  it("limits small-scene drift and keeps large-scene edges inside insets", () => {
    const size = { width: 800, height: 600 };
    const options = { insets: { left: 20, right: 100, top: 30, bottom: 30 } };
    expect(clampStarMapCamera(
      { x: 10_000, y: -10_000, zoom: 1 }, { left: 0, top: 0, right: 100, bottom: 80 }, size, options,
    )).toEqual({ x: 600, y: 30, zoom: 1 });
    const large = { left: 0, top: 0, right: 1000, bottom: 800 };
    expect(clampStarMapCamera({ x: 10_000, y: 10_000, zoom: 1 }, large, size, options)).toEqual({ x: 20, y: 30, zoom: 1 });
    expect(clampStarMapCamera({ x: -10_000, y: -10_000, zoom: 1 }, large, size, options)).toEqual({ x: -300, y: -230, zoom: 1 });
  });

  it("samples the 440ms cubic morph and completes immediately for reduced motion", () => {
    expect(starMapMorphAt(100, 50)).toEqual({ progress: 0, eased: 0, done: false });
    expect(starMapMorphAt(100, 320)).toEqual({ progress: 0.5, eased: 0.5, done: false });
    expect(starMapMorphAt(100, 540)).toEqual({ progress: 1, eased: 1, done: true });
    expect(starMapMorphAt(100, 50, { reducedMotion: true })).toEqual({ progress: 1, eased: 1, done: true });
    expect(starMapMorphAt(100, 100, { duration: 0 })).toEqual({ progress: 1, eased: 1, done: true });
  });
});
