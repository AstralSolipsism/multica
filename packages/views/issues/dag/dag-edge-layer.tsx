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
  dagMotionSegments,
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
  /** The selected card/frame, ringed in brand blue (the only use of brand
   *  on the canvas) — painted here so a selection never rebuilds nodes. */
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
  const maskId = useId();
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

  // Motion: candidates are the visible advancing/cancelled segments; the
  // budget keeps the selected chain moving when the screen is too busy.
  const motionCandidates = useMemo(
    () =>
      visibleSegments.flatMap(({ segment, display }) => {
        const kind = dagStateMotion(display.state);
        return kind ? [{ id: segment.id, edgeIds: segment.edgeIds }] : [];
      }),
    [visibleSegments],
  );
  const activeMotion = useMemo(
    () =>
      dagMotionSegments({
        candidates: motionCandidates,
        highlightedEdgeIds,
        zoom: motionOn ? 1 : 0,
        reducedMotion,
      }),
    [motionCandidates, highlightedEdgeIds, motionOn, reducedMotion],
  );
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
        const lit = highlightedEdgeIds
          ? segment.edgeIds.some((edgeId) => highlightedEdgeIds.has(edgeId))
          : false;
        return [{ segment, display, direction, lit }];
      }),
    [visibleSegments, activeMotion, plan, states, showSatisfied, composed.routes, highlightedEdgeIds],
  );
  const litFlows = flowOverlays.filter(({ lit }) => lit);
  const baseFlows = flowOverlays.filter(({ lit }) => !lit);
  const motionAllowed = dagMotionAllowed(motionOn ? 1 : 0, reducedMotion);

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

  const dimmed = highlightedEdgeIds != null;
  const dimNodes = litBoxes != null && litBoxes.length > 0;
  // Both overlay masks must declare their region explicitly: the
  // userSpaceOnUse default (-10%/-10%/120%/120% of the viewport) resolves to
  // ABSOLUTE coordinates that do not follow the windowed viewBox origin, so
  // about one screen past the canvas origin every masked paint would be
  // clipped away (OL-451 review; the dim mask carried the same latent defect
  // since OL-284). One shared window rect feeds the mask regions and their
  // white bases.
  const windowRect = bounds
    ? { x: bounds.x0, y: bounds.y0, width: bounds.x1 - bounds.x0, height: bounds.y1 - bounds.y0 }
    : { x: 0, y: 0, width: geometry.width, height: geometry.height };
  // Lit routes repaint ABOVE the cards, so a route crossing a card would
  // strike through its text (the OL-284 leftover, OL-451). The lit group
  // paints through a mask cutting every card box (inset a hair, so port
  // approaches and arrowheads on the box edge stay) and every frame header
  // strip: routes visibly pass behind cards, exactly like the base layer
  // already does below them. Skipped in the simplified view — no text there,
  // and the cut count stays bounded by the readable zoom's smaller window.
  const routeMaskCuts = useMemo(() => {
    if (degraded || highlightedEdgeIds == null) return null;
    const cuts: { id: string; x: number; y: number; width: number; height: number }[] = [];
    const visible = (x: number, y: number, width: number, height: number) =>
      !bounds ||
      (x + width >= bounds.x0 && x <= bounds.x1 && y + height >= bounds.y0 && y <= bounds.y1);
    for (const [id, box] of Object.entries(geometry.nodes)) {
      if (!visible(box.x, box.y, box.width, box.height)) continue;
      cuts.push({ id, x: box.x + 2, y: box.y + 2, width: Math.max(0, box.width - 4), height: Math.max(0, box.height - 4) });
    }
    for (const [id, box] of Object.entries(geometry.frames)) {
      if (!visible(box.x, box.y, box.width, DAG_GROUP_HEADER_HEIGHT)) continue;
      cuts.push({ id, x: box.x + 2, y: box.y + 2, width: Math.max(0, box.width - 4), height: DAG_GROUP_HEADER_HEIGHT - 4 });
    }
    return cuts;
  }, [degraded, highlightedEdgeIds, geometry, bounds]);
  const selectedBox = useMemo(() => {
    if (!selectedNodeId) return null;
    return geometry.nodes[selectedNodeId] ?? geometry.frames[selectedNodeId] ?? null;
  }, [selectedNodeId, geometry]);
  // Ghost blocks: simplified cards as a handful of rects, grouped like the
  // segments. The dim mask's holes cover them exactly (same coordinates).
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
          {baseFlows.map((overlay) => flowLine(overlay, `flow:${overlay.segment.id}`))}
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
    {(dimNodes || highlightedRoutes.length > 0 || litFlows.length > 0) && (
      // Above the z-index-2 cards: node dimming is a full-scene rect whose
      // mask punches holes over the lit cards (and lit frames' headers), and
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
          <>
            <defs>
              <mask
                id={maskId}
                maskUnits="userSpaceOnUse"
                x={windowRect.x}
                y={windowRect.y}
                width={windowRect.width}
                height={windowRect.height}
              >
                <rect {...windowRect} fill="white" />
                {litBoxes!.map((box) => (
                  <rect
                    key={box.id}
                    data-dag-dim-hole={box.id}
                    x={box.x - 8}
                    y={box.y - 8}
                    width={box.width + 16}
                    height={box.height + 16}
                    rx={10}
                    fill="black"
                  />
                ))}
              </mask>
            </defs>
            <rect
              data-dag-dim-overlay
              {...windowRect}
              fill="var(--background)"
              fillOpacity={0.75}
              mask={`url(#${maskId})`}
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
          {highlightedRoutes.map(({ edgeId, route, display }) => {
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
          {litFlows.map((overlay) => flowLine(overlay, `lit-flow:${overlay.segment.id}`))}
        </g>
      </svg>
    )}
    </>
  );
});
