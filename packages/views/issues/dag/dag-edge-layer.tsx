"use client";

import { memo, useId, useMemo } from "react";
import { aggregateDagDependencyState, type DagDependencyState } from "@multica/core/issues/dag";
import type { DagPoint } from "./dag-scene";
import type { DagSceneGeometry, DagScenePlan, DagSceneSegment } from "./dag-scene";
import { dagRouteMidpoint } from "./dag-route";
import {
  dagDependencyStates,
  dagDisplayedRoutes,
  dagSceneEdgeDisplay,
  dagSegmentDisplay,
  type DagCanvasModel,
} from "./dag-scene-flow";
import { DAG_GROUP_HEADER_HEIGHT } from "./dag-constants";
import {
  dagBusDependencyIds,
  dagMotionAllowed,
  dagMotionPlan,
  dagPointVisible,
  dagRouteVisible,
  dagSegmentFlowDirection,
  dagSegmentVisible,
  dagStateMotion,
  type DagGhostBlock,
  type DagSatisfiedOverlay,
  type DagVisibleBounds,
} from "./dag-highlight";
import "./dag-edge-motion.css";

/** Static edge styles for the four dependency states (OL-183 §4). Advancing
 *  adds flowing dots and cancelled-blocking breathes via dag-edge-motion.css. */
const STATE_STYLE: Record<
  DagDependencyState,
  { stroke: string; opacity: number; dash?: string }
> = {
  satisfied: { stroke: "var(--muted-foreground)", opacity: 0.35 },
  blocking: { stroke: "var(--foreground)", opacity: 0.55 },
  advancing: { stroke: "var(--foreground)", opacity: 0.55 },
  "cancelled-blocking": { stroke: "var(--destructive)", opacity: 0.85, dash: "6 4" },
};

/** The OL-997 lit-route flow colors: brand blue while a dependency still
 *  blocks (the only brand paint besides the selection ring), a softened
 *  success green once satisfied (silver-white washes out on light themes),
 *  destructive red for a cancelled blocker. */
const LIT_FLOW_STYLE: Record<
  DagDependencyState,
  { stroke: string; opacity: number }
> = {
  satisfied: { stroke: "var(--success)", opacity: 0.55 },
  blocking: { stroke: "var(--color-brand)", opacity: 0.95 },
  advancing: { stroke: "var(--color-brand)", opacity: 0.95 },
  "cancelled-blocking": { stroke: "var(--destructive)", opacity: 0.95 },
};

/** Flow-dot speed along a route (flow px per second): the same for every
 *  route, so long and short chains read as one calm current. */
const DAG_LIT_FLOW_SPEED = 55;

/** Paint order when lit routes share a bus interval: satisfied at the bottom,
 *  unsatisfied in the middle, cancelled blockers on top — the attention order
 *  stacked, never blended. */
function litPaintRank(state: DagDependencyState): number {
  if (state === "satisfied") return 0;
  if (state === "cancelled-blocking") return 2;
  return 1;
}

function arrowHead(
  route: readonly DagPoint[],
  key: string,
  stroke: string,
  opacity: number,
): React.ReactNode {
  if (route.length < 2) return null;
  const a = route[route.length - 2]!;
  const b = route[route.length - 1]!;
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return (
    <path
      key={key}
      d="M 0 0 L -7 -3.2 L -7 3.2 Z"
      transform={`translate(${b.x} ${b.y}) rotate(${angle})`}
      fill={stroke}
      opacity={opacity}
    />
  );
}

/** A bus segment shortened at both ends so its hit zone never covers the
 *  cards its route attaches to. Too-short stubs get no hit zone at all. */
function hitSegment(
  segment: DagSceneSegment,
  inset: number,
): { start: DagPoint; end: DagPoint } | null {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= inset * 2) return null;
  const ux = dx / length;
  const uy = dy / length;
  return {
    start: { x: segment.start.x + ux * inset, y: segment.start.y + uy * inset },
    end: { x: segment.end.x - ux * inset, y: segment.end.y - uy * inset },
  };
}

export interface DagEdgeLayerProps {
  geometry: DagSceneGeometry;
  plan: DagScenePlan;
  model: DagCanvasModel;
  showSatisfied: boolean;
  /** Lit scene edges (node neighborhood, focus chain, bus selection). Each
   *  repaints along its own complete route; the base layer dims meanwhile. */
  highlightedEdgeIds: ReadonlySet<string> | null;
  /** The effective satisfied-dependency overlay (focus anchor's while
   *  focusing, otherwise the selected card's) adds its satisfied bundles
   *  without a layout pass. */
  activeOverlay: DagSatisfiedOverlay | null;
  /** Boxes that stay visible through the dim mask: lit cards in full, lit
   *  frames as header strips. Null (and empty) means no node dimming. */
  litBoxes: readonly { id: string; x: number; y: number; width: number; height: number }[] | null;
  /** Below the readability zoom, simplified cards paint here as SVG rects
   *  while their DOM shells stay interactive. */
  ghostBlocks: readonly DagGhostBlock[] | null;
  /** The selected card/frame, ringed in brand blue (with the lit chain's
   *  unsatisfied flow, the only brand on the canvas) — painted here so a
   *  selection never rebuilds nodes. */
  selectedNodeId: string | null;
  /** Flow-coordinate culling bounds; null paints everything (tests, SSR). */
  bounds: DagVisibleBounds | null;
  /** Below the readability zoom: badges, arrows and junction dots degrade
   *  away with the card text. */
  degraded: boolean;
  /** Motion gates: zoom (already thresholded by the caller) and the system's
   *  reduced-motion setting. The ~60-segment budget applies here. */
  /** Motion gate, already thresholded by the caller. */
  motionOn: boolean;
  reducedMotion: boolean;
  /** Bus click: the original dependency IDs running through the segment. */
  onBusClick: (dependencyIds: string[]) => void;
}

/**
 * All edges of the current scene as one viewport-space SVG: shared bus
 * intervals are painted exactly once with the worst traversing state, branch
 * points get dots, and bundle routes carry their dependency count. Visible
 * segments double as bus click targets; motion and dimming follow OL-183 §4/§5.
 */
export const DagEdgeLayer = memo(function DagEdgeLayer({
  geometry,
  plan,
  model,
  showSatisfied,
  highlightedEdgeIds,
  activeOverlay,
  litBoxes,
  ghostBlocks,
  selectedNodeId,
  bounds,
  degraded,
  motionOn,
  reducedMotion,
  onBusClick,
}: DagEdgeLayerProps) {
  const routeMaskId = useId();
  const states = useMemo(() => dagDependencyStates(model), [model]);
  const composed = useMemo(
    () => dagDisplayedRoutes(geometry, plan, showSatisfied),
    [geometry, plan, showSatisfied],
  );
  const segments = useMemo(
    () =>
      composed.segments.flatMap((segment) => {
        const display = dagSegmentDisplay(segment.edgeIds, plan, states, showSatisfied);
        if (!display) return [];
        return [{ segment, display }];
      }),
    [composed.segments, plan, states, showSatisfied],
  );
  const visibleSegments = useMemo(
    () =>
      bounds
        ? segments.filter(({ segment }) => dagSegmentVisible(segment, bounds))
        : segments,
    [segments, bounds],
  );
  // Bus memberships only pay for the aimable hit zones they render.
  const busIdsBySegment = useMemo(
    () =>
      new Map(
        visibleSegments.map(({ segment }) => [
          segment.id,
          dagBusDependencyIds(segment.edgeIds, plan),
        ]),
      ),
    [visibleSegments, plan],
  );
  const arrows = useMemo(
    () =>
      Object.entries(composed.routes).flatMap(([edgeId, route]) => {
        const display = dagSceneEdgeDisplay(plan, edgeId, states, showSatisfied);
        if (!display) return [];
        return [{ edgeId, route, display }];
      }),
    [composed.routes, plan, states, showSatisfied],
  );
  const visibleArrows = useMemo(() => {
    if (degraded || !bounds) return degraded ? [] : arrows;
    return arrows.filter(({ route }) => dagRouteVisible(route, bounds));
  }, [arrows, bounds, degraded]);
  const visibleJunctions = useMemo(() => {
    if (degraded || !bounds) return degraded ? [] : composed.junctions;
    return composed.junctions.filter((junction) => dagPointVisible(junction, bounds));
  }, [composed.junctions, bounds, degraded]);
  const badges = useMemo(() => {
    if (plan.input.kind !== "overview" || degraded) return [];
    return visibleArrows
      .filter(({ display }) => display.count > 1)
      .map(({ edgeId, route, display }) => ({
        edgeId,
        point: dagRouteMidpoint(route),
        count: display.count,
      }))
      .filter(({ point }) => !bounds || dagPointVisible(point, bounds));
  }, [visibleArrows, plan.input.kind, bounds, degraded]);

  // Highlight: repaint each lit dependency's own complete route — never the
  // whole bus. Satisfied-only bundles take the active overlay's route and the
  // satisfied-subset count (mixed bundles never double-count).
  const highlightedRoutes = useMemo(() => {
    if (!highlightedEdgeIds) return [];
    return [...highlightedEdgeIds].flatMap((edgeId) => {
      const route = composed.routes[edgeId] ?? activeOverlay?.routes[edgeId];
      if (!route) return [];
      let display = dagSceneEdgeDisplay(plan, edgeId, states, showSatisfied);
      if (!display) {
        const rawIds = activeOverlay?.dependencyIds[edgeId] ?? [];
        if (!rawIds.length) return [];
        display = {
          count: rawIds.length,
          state: aggregateDagDependencyState(
            rawIds.map((id) => states.get(id) ?? "satisfied"),
          ),
        };
      }
      if (bounds && !dagRouteVisible(route, bounds)) return [];
      return [{ edgeId, route, display }];
    });
  }, [highlightedEdgeIds, composed.routes, activeOverlay, plan, states, showSatisfied, bounds]);
  // Shared bus intervals stack by attention: satisfied at the bottom,
  // cancelled blockers on top. The sort is stable — same-state routes keep
  // their scene order.
  const paintedLitRoutes = useMemo(
    () =>
      [...highlightedRoutes].sort(
        (a, b) => litPaintRank(a.display.state) - litPaintRank(b.display.state),
      ),
    [highlightedRoutes],
  );

  // Motion: candidates are the visible advancing/cancelled segments; lit
  // routes ask for their state-colored flow. The shared budget keeps only the
  // lit chain moving when the screen is too busy.
  const motionCandidates = useMemo(
    () =>
      visibleSegments.flatMap(({ segment, display }) => {
        const kind = dagStateMotion(display.state);
        return kind ? [{ id: segment.id, edgeIds: segment.edgeIds }] : [];
      }),
    [visibleSegments],
  );
  const motion = useMemo(
    () =>
      dagMotionPlan({
        candidates: motionCandidates,
        litRoutes: highlightedRoutes.map(({ edgeId, display }) => ({
          id: edgeId,
          state: display.state,
        })),
        zoom: motionOn ? 1 : 0,
        reducedMotion,
      }),
    [motionCandidates, highlightedRoutes, motionOn, reducedMotion],
  );
  const activeMotion = motion.segments;
  const litFlowEdgeIds = motion.flows;
  const flowOverlays = useMemo(
    () =>
      visibleSegments.flatMap(({ segment, display }) => {
        if (display.state !== "advancing" || !activeMotion.has(segment.id)) return [];
        const representative = segment.edgeIds.find(
          (edgeId) =>
            dagSceneEdgeDisplay(plan, edgeId, states, showSatisfied)?.state === "advancing",
        );
        const route = representative ? composed.routes[representative] : undefined;
        const direction = route ? dagSegmentFlowDirection(route, segment) : 1;
        return [{ segment, display, direction }];
      }),
    [visibleSegments, activeMotion, plan, states, showSatisfied, composed.routes],
  );
  const motionAllowed = dagMotionAllowed(motionOn ? 1 : 0, reducedMotion);

  const dimmed = highlightedEdgeIds != null;
  const dimNodes = litBoxes != null && litBoxes.length > 0;
  // The route mask must declare its region explicitly: the userSpaceOnUse
  // default (-10%/-10%/120%/120% of the viewport) resolves to ABSOLUTE
  // coordinates that do not follow the windowed viewBox origin, so about one
  // screen past the canvas origin every masked paint would be clipped away
  // (OL-451 review; the dim overlay carried the same latent defect since
  // OL-284 — it now paints as one even-odd path, whose coordinates are
  // absolute by construction). One shared window rect feeds the mask region,
  // its white base and the dim path's outer subpath.
  const windowRect = bounds
    ? { x: bounds.x0, y: bounds.y0, width: bounds.x1 - bounds.x0, height: bounds.y1 - bounds.y0 }
    : { x: 0, y: 0, width: geometry.width, height: geometry.height };
  // Lit routes repaint ABOVE the cards, so a route crossing a card would
  // strike through its text (the OL-284 leftover, OL-451). The lit group
  // paints through a mask cutting every card box (inset a hair, so port
  // approaches and arrowheads on the box edge stay) and every frame header
  // strip: routes visibly pass behind cards, exactly like the base layer
  // already does below them. Only boxes a lit route actually crosses are
  // cut — the OL-997 flow re-applies this mask every animation frame, so
  // its rect count must stay proportional to the chain, not the window.
  // Skipped in the simplified view — no text there.
  const routeMaskCuts = useMemo(() => {
    if (degraded || highlightedEdgeIds == null) return null;
    const boxes: { id: string; x: number; y: number; width: number; height: number }[] = [];
    for (const [id, box] of Object.entries(geometry.nodes)) boxes.push({ id, ...box });
    for (const [id, box] of Object.entries(geometry.frames))
      boxes.push({ id, x: box.x, y: box.y, width: box.width, height: DAG_GROUP_HEADER_HEIGHT });
    const crosses = (box: { x: number; y: number; width: number; height: number }) => {
      if (
        bounds &&
        (box.x + box.width < bounds.x0 ||
          box.x > bounds.x1 ||
          box.y + box.height < bounds.y0 ||
          box.y > bounds.y1)
      )
        return false;
      const pad = 6;
      for (const { route } of highlightedRoutes) {
        for (let i = 0; i + 1 < route.length; i++) {
          const a = route[i]!;
          const b = route[i + 1]!;
          if (
            Math.min(a.x, b.x) - pad <= box.x + box.width &&
            Math.max(a.x, b.x) + pad >= box.x &&
            Math.min(a.y, b.y) - pad <= box.y + box.height &&
            Math.max(a.y, b.y) + pad >= box.y
          )
            return true;
        }
      }
      return false;
    };
    return boxes
      .filter(crosses)
      .map((box) => ({
        id: box.id,
        x: box.x + 2,
        y: box.y + 2,
        width: Math.max(0, box.width - 4),
        height: Math.max(0, box.height - 4),
      }));
  }, [degraded, highlightedEdgeIds, geometry, bounds, highlightedRoutes]);
  const selectedBox = useMemo(() => {
    if (!selectedNodeId) return null;
    return geometry.nodes[selectedNodeId] ?? geometry.frames[selectedNodeId] ?? null;
  }, [selectedNodeId, geometry]);
  // The OL-997 flow dots: one glowing dot (plus a short trailing echo) per
  // flowing route, traveling the route's own point order via CSS motion
  // path (SVG user space = flow coordinates, so no origin math). Duration
  // scales with route length, so every dot moves at the same calm speed.
  // Dots paint as SVG circles inside the lit group — not a separate HTML
  // layer: an extra full-window composited layer costs several fps per pan
  // frame on GPU-less (software) compositors, and the group's existing
  // route mask hides them behind cards for free.
  const flowDots = useMemo(
    () =>
      paintedLitRoutes.flatMap(({ edgeId, route, display }) => {
        if (!litFlowEdgeIds.has(edgeId)) return [];
        let length = 0;
        for (let i = 0; i + 1 < route.length; i++)
          length += Math.hypot(route[i + 1]!.x - route[i]!.x, route[i + 1]!.y - route[i]!.y);
        if (!length) return [];
        return [
          {
            edgeId,
            state: display.state,
            points: route.map((p) => `${p.x},${p.y}`).join(" "),
            path: `M ${route.map((p) => `${p.x} ${p.y}`).join(" L ")}`,
            duration: Math.max(1.2, length / DAG_LIT_FLOW_SPEED),
          },
        ];
      }),
    [paintedLitRoutes, litFlowEdgeIds],
  );
  // Ghost blocks: simplified cards as a handful of rects, grouped like the
  // segments. The dim path's holes cover them exactly (same coordinates).
  const ghost = useMemo(() => {
    if (!ghostBlocks) return null;
    const visible = ghostBlocks.filter(
      (block) =>
        !bounds ||
        (block.x + block.width >= bounds.x0 &&
          block.x <= bounds.x1 &&
          block.y + block.height >= bounds.y0 &&
          block.y <= bounds.y1),
    );
    const body: string[] = [];
    const dashedBody: string[] = [];
    const frames: string[] = [];
    const externals: string[] = [];
    const strips = new Map<string, string[]>();
    for (const block of visible) {
      const rect = `M ${block.x} ${block.y} h ${block.width} v ${block.height} h ${-block.width} Z`;
      if (block.kind === "frame") frames.push(rect);
      else if (block.kind === "external") externals.push(rect);
      else {
        body.push(rect);
        if (block.dashed) dashedBody.push(rect);
        if (block.color) {
          const strip = `M ${block.x} ${block.y} h 6 v ${block.height} h -6 Z`;
          (strips.get(block.color) ?? strips.set(block.color, []).get(block.color)!).push(strip);
        }
      }
    }
    return {
      visible,
      body: body.join(" "),
      dashedBodies: dashedBody.join(" "),
      frames: frames.join(" "),
      externals: externals.join(" "),
      strips,
    };
  }, [ghostBlocks, bounds]);
  // With culling active the layer becomes a window-sized compositable layer:
  // the SVG only spans the quantized visible window (viewBox keeps flow
  // coordinates), so panning composites instead of re-rasterizing the whole
  // scene every frame. Without bounds (tests, SSR) it spans the geometry.
  const windowed = bounds != null;

  // Painted segments group into one <path> per style: thousands of intervals
  // cost a handful of DOM nodes instead of thousands, so a culling re-render
  // during pan/zoom stays cheap (OL-284 zoom frame budget).
  const segmentGroups = useMemo(() => {
    const groups = new Map<
      string,
      { state: DagDependencyState; width: number; breathe: boolean; d: string[]; ids: string[] }
    >();
    for (const { segment, display } of visibleSegments) {
      const breathe = display.state === "cancelled-blocking" && activeMotion.has(segment.id);
      const key = `${display.state}|${display.width}|${breathe}`;
      let group = groups.get(key);
      if (!group) {
        group = { state: display.state, width: display.width, breathe, d: [], ids: [] };
        groups.set(key, group);
      }
      group.d.push(
        `M ${segment.start.x} ${segment.start.y} L ${segment.end.x} ${segment.end.y}`,
      );
      group.ids.push(segment.id);
    }
    return [...groups.entries()];
  }, [visibleSegments, activeMotion]);

  const flowLine = (
    { segment, display, direction }: { segment: DagSceneSegment; display: { width: number }; direction: 1 | -1 },
    key: string,
  ) => {
    const start = direction === 1 ? segment.start : segment.end;
    const end = direction === 1 ? segment.end : segment.start;
    return (
      <line
        key={key}
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        className="dag-edge-flow"
        stroke="var(--background)"
        strokeOpacity={0.95}
        strokeWidth={Math.max(1.2, display.width - 0.4)}
        strokeLinecap="round"
      />
    );
  };

  const windowedSvgProps = windowed
    ? {
        className: "pointer-events-none absolute overflow-hidden",
        style: { left: bounds.x0, top: bounds.y0, willChange: "transform" as const },
        width: bounds.x1 - bounds.x0,
        height: bounds.y1 - bounds.y0,
        viewBox: `${bounds.x0} ${bounds.y0} ${bounds.x1 - bounds.x0} ${bounds.y1 - bounds.y0}`,
      }
    : {
        className: "pointer-events-none absolute left-0 top-0 overflow-visible",
        width: geometry.width,
        height: geometry.height,
      };

  return (
    <>
      <svg data-dag-edge-layer {...windowedSvgProps} aria-hidden>
        <g className={dimmed ? "opacity-15 transition-opacity" : "transition-opacity"}>
          {segmentGroups.map(([key, group]) => {
            const style = STATE_STYLE[group.state];
            return (
              <path
                key={key}
                data-dag-segments={group.ids.join(" ")}
                d={group.d.join(" ")}
                className={group.breathe ? "dag-edge-breathe" : undefined}
                stroke={style.stroke}
                strokeOpacity={style.opacity}
                strokeWidth={group.width}
                strokeDasharray={style.dash}
                strokeLinecap="round"
                fill="none"
              />
            );
          })}
          {flowOverlays.map((overlay) => flowLine(overlay, `flow:${overlay.segment.id}`))}
          {visibleJunctions.map((junction) => (
            <circle
              key={`${junction.x},${junction.y}`}
              cx={junction.x}
              cy={junction.y}
              r={3}
              fill="var(--foreground)"
              fillOpacity={0.55}
            />
          ))}
          {visibleArrows.map(({ edgeId, route, display }) => {
            const style = STATE_STYLE[display.state];
            return arrowHead(route, edgeId, style.stroke, style.opacity);
          })}
          {badges.map(({ edgeId, point, count }) => {
            const label = String(count);
            const width = label.length * 7 + 10;
            return (
              <g key={edgeId} transform={`translate(${point.x} ${point.y})`}>
                <rect
                  x={-width / 2}
                  y={-9}
                  width={width}
                  height={18}
                  rx={9}
                  fill="var(--card)"
                  stroke="var(--border)"
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={11}
                  fill="var(--muted-foreground)"
                  className="tabular-nums"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>
        {/* Simplified cards below the readability zoom: SVG rects whose DOM
            shells stay interactive. Painted over edge endpoints like the DOM
            cards would; cancelled blockers keep their dashed mark. */}
        {ghost && (
          <g data-dag-ghost-blocks>
            {ghost.body && (
              <path data-dag-ghost="tasks" d={ghost.body} fill="var(--muted)" fillOpacity={0.55} stroke="var(--border)" />
            )}
            {[...ghost.strips.entries()].map(([color, d]) => (
              <path key={color} d={d.join(" ")} fill={color} />
            ))}
            {ghost.dashedBodies && (
              <path
                data-dag-ghost="dashed"
                d={ghost.dashedBodies}
                fill="none"
                stroke="var(--border)"
                strokeDasharray="5 3"
              />
            )}
            {ghost.frames && (
              <path data-dag-ghost="frames" d={ghost.frames} fill="var(--muted)" fillOpacity={0.25} stroke="var(--muted-foreground)" strokeOpacity={0.3} />
            )}
            {ghost.externals && (
              <path data-dag-ghost="externals" d={ghost.externals} fill="var(--muted)" fillOpacity={0.25} stroke="var(--muted-foreground)" strokeOpacity={0.45} strokeDasharray="4 3" />
            )}
          </g>
        )}
        {selectedBox && (
          <g data-dag-selected={selectedNodeId}>
            <rect
              x={selectedBox.x - 3}
              y={selectedBox.y - 3}
              width={selectedBox.width + 6}
              height={selectedBox.height + 6}
              rx={10}
              fill="none"
              stroke="var(--color-brand)"
              strokeOpacity={0.3}
              strokeWidth={6}
            />
            <rect
              x={selectedBox.x - 3}
              y={selectedBox.y - 3}
              width={selectedBox.width + 6}
              height={selectedBox.height + 6}
              rx={10}
              fill="none"
              stroke="var(--color-brand)"
              strokeWidth={2}
            />
          </g>
        )}
        {/* Bus hit zones: transparent, inset from both ends, pointer only on the
            stroke. Clicking selects the segment's original dependencies. */}
        {visibleSegments.flatMap(({ segment }) => {
              const busIds = busIdsBySegment.get(segment.id) ?? [];
              if (!busIds.length) return [];
              const hit = hitSegment(segment, 8);
              if (!hit) return [];
              return [
                <line
                  key={`hit:${segment.id}`}
                  data-dag-bus-hit={segment.id}
                  x1={hit.start.x}
                  y1={hit.start.y}
                  x2={hit.end.x}
                  y2={hit.end.y}
                  className="nopan stroke-transparent transition-colors hover:stroke-foreground/15"
                  strokeWidth={10}
                  strokeLinecap="round"
                  style={{ pointerEvents: "stroke", cursor: "pointer" }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onBusClick(busIds);
                  }}
                >
                  <title>{busIds.length}</title>
                </line>,
              ];
            })}
      </svg>
    {(dimNodes || highlightedRoutes.length > 0) && (
      // Above the z-index-2 cards: node dimming is a full-scene even-odd
      // path with holes over the lit cards (and lit frames' headers), and
      // the lit chain repaints each dependency's own complete route with a
      // soft glow after it, so dimming never dulls the chain itself. The
      // layer renders whenever either is present — a bus selection lights
      // routes without dimming anything.
      <svg
        data-dag-overlay-layer
        {...windowedSvgProps}
        style={{
          ...(windowedSvgProps as { style?: React.CSSProperties }).style,
          zIndex: 3,
        }}
        aria-hidden
      >
        {dimNodes && (
          // The dim rect is ONE even-odd path (window outside, lit boxes as
          // hole subpaths) — not a masked rect: a mask costs the compositor
          // an extra offscreen pass every frame on GPU-less (software)
          // compositing. The hole markers stay as non-rendering geometry for
          // tests and debugging.
          <>
            <defs>
              {litBoxes!.map((box) => (
                <rect
                  key={box.id}
                  data-dag-dim-hole={box.id}
                  x={box.x - 8}
                  y={box.y - 8}
                  width={box.width + 16}
                  height={box.height + 16}
                  rx={10}
                  fill="none"
                />
              ))}
            </defs>
            <path
              data-dag-dim-overlay
              d={[
                `M ${windowRect.x} ${windowRect.y} h ${windowRect.width} v ${windowRect.height} h ${-windowRect.width} Z`,
                ...litBoxes!.map((box) => {
                  const x = box.x - 8,
                    y = box.y - 8,
                    w = box.width + 16,
                    h = box.height + 16,
                    r = 10;
                  return `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
                }),
              ].join(" ")}
              fillRule="evenodd"
              fill="var(--background)"
              fillOpacity={0.75}
            />
          </>
        )}
        {routeMaskCuts && (
          <defs>
            <mask
              id={routeMaskId}
              maskUnits="userSpaceOnUse"
              x={windowRect.x}
              y={windowRect.y}
              width={windowRect.width}
              height={windowRect.height}
            >
              <rect {...windowRect} fill="white" />
              {routeMaskCuts.map((cut) => (
                <rect
                  key={cut.id}
                  data-dag-route-mask-cut={cut.id}
                  x={cut.x}
                  y={cut.y}
                  width={cut.width}
                  height={cut.height}
                  fill="black"
                />
              ))}
            </mask>
          </defs>
        )}
        <g mask={routeMaskCuts ? `url(#${routeMaskId})` : undefined}>
          {paintedLitRoutes.map(({ edgeId, route, display }) => {
            const style = STATE_STYLE[display.state];
            const points = route.map((p) => `${p.x},${p.y}`).join(" ");
            const width = display.count > 1 ? 3 : 2;
            const breathe = display.state === "cancelled-blocking" && motionAllowed;
            return (
              <g key={`lit:${edgeId}`} data-dag-lit-edge={edgeId}>
                <polyline
                  points={points}
                  fill="none"
                  stroke={style.stroke}
                  strokeOpacity={0.25}
                  strokeWidth={width + 5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <polyline
                  points={points}
                  fill="none"
                  className={breathe ? "dag-edge-breathe" : undefined}
                  stroke={style.stroke}
                  strokeOpacity={Math.min(1, style.opacity + 0.35)}
                  strokeWidth={width}
                  strokeDasharray={style.dash}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {arrowHead(route, `lit-arrow:${edgeId}`, style.stroke, 0.9)}
              </g>
            );
          })}
          {flowDots.map(({ edgeId, state, points, path, duration }) => {
            // Each dot travels its dependency's complete route via CSS motion
            // path — source → target, corners included, so shared bus
            // intervals follow each route's own direction; the trailing echo
            // reads as a short tail. The route mask above hides them behind
            // cards, exactly like the lit lines.
            const flow = LIT_FLOW_STYLE[state];
            const offsetPath = `path("${path}")`;
            return (
              <g
                key={`flow:${edgeId}`}
                data-dag-lit-flow={edgeId}
                data-dag-lit-flow-state={state}
                data-dag-lit-flow-path={points}
              >
                <circle
                  r={4.5}
                  className="dag-lit-flow-dot"
                  fill={flow.stroke}
                  opacity={flow.opacity}
                  style={{ offsetPath, animationDuration: `${duration}s` }}
                />
                <circle
                  r={2.2}
                  className="dag-lit-flow-dot"
                  fill={flow.stroke}
                  opacity={flow.opacity * 0.55}
                  style={{
                    offsetPath,
                    animationDuration: `${duration}s`,
                    animationDelay: `-${(duration * 0.09).toFixed(2)}s`,
                  }}
                />
              </g>
            );
          })}
        </g>
      </svg>
    )}
    </>
  );
});
