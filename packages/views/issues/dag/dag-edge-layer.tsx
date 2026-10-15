"use client";

import { memo, useMemo } from "react";
import type { DagDependencyState } from "@multica/core/issues/dag";
import type { DagPoint } from "./dag-scene";
import type { DagSceneGeometry, DagScenePlan } from "./dag-scene";
import { dagRouteMidpoint } from "./dag-route";
import {
  dagDependencyStates,
  dagDisplayedRoutes,
  dagSceneEdgeDisplay,
  dagSegmentDisplay,
  type DagCanvasModel,
  type DagFocusSet,
} from "./dag-scene-flow";

/** Static edge styles for the four dependency states (OL-183 §4). Motion —
 *  flowing dots on advancing edges, breathing on cancelled ones — is Stage 10. */
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

export interface DagEdgeLayerProps {
  geometry: DagSceneGeometry;
  plan: DagScenePlan;
  model: DagCanvasModel;
  showSatisfied: boolean;
  focus: DagFocusSet | null;
}

/**
 * All edges of the current scene as one viewport-space SVG: shared bus
 * intervals are painted exactly once with the worst traversing state, branch
 * points get dots, and bundle routes carry their dependency count. The layer
 * is inert to pointer events — trunk hit-testing arrives with Stage 10.
 */
export const DagEdgeLayer = memo(function DagEdgeLayer({
  geometry,
  plan,
  model,
  showSatisfied,
  focus,
}: DagEdgeLayerProps) {
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
  const arrows = useMemo(
    () =>
      Object.entries(composed.routes).flatMap(([edgeId, route]) => {
        const display = dagSceneEdgeDisplay(plan, edgeId, states, showSatisfied);
        if (!display) return [];
        return [{ edgeId, route, display }];
      }),
    [composed.routes, plan, states, showSatisfied],
  );
  const badges = useMemo(() => {
    if (plan.input.kind !== "overview") return [];
    return arrows
      .filter(({ display }) => display.count > 1)
      .map(({ edgeId, route, display }) => ({
        edgeId,
        point: dagRouteMidpoint(route),
        count: display.count,
      }));
  }, [arrows, plan.input.kind]);
  const focusedRoutes = useMemo(() => {
    if (!focus) return [];
    return [...focus.edgeIds].flatMap((edgeId) => {
      const route = composed.routes[edgeId];
      const display = dagSceneEdgeDisplay(plan, edgeId, states, showSatisfied);
      if (!route || !display) return [];
      return [{ edgeId, route, display }];
    });
  }, [focus, composed.routes, plan, states, showSatisfied]);

  return (
    <svg
      data-dag-edge-layer
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={geometry.width}
      height={geometry.height}
      aria-hidden
    >
      <g className={focus ? "opacity-15 transition-opacity" : "transition-opacity"}>
        {segments.map(({ segment, display }) => {
          const style = STATE_STYLE[display.state];
          return (
            <line
              key={segment.id}
              x1={segment.start.x}
              y1={segment.start.y}
              x2={segment.end.x}
              y2={segment.end.y}
              stroke={style.stroke}
              strokeOpacity={style.opacity}
              strokeWidth={display.width}
              strokeDasharray={style.dash}
              strokeLinecap="round"
            />
          );
        })}
        {composed.junctions.map((junction) => (
          <circle
            key={`${junction.x},${junction.y}`}
            cx={junction.x}
            cy={junction.y}
            r={3}
            fill="var(--foreground)"
            fillOpacity={0.55}
          />
        ))}
        {arrows.map(({ edgeId, route, display }) => {
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
      {/* The focused chain repaints each dependency's own complete route —
          highlight never spreads along a shared bus. */}
      {focusedRoutes.map(({ edgeId, route, display }) => {
        const style = STATE_STYLE[display.state];
        return (
          <g key={`focus:${edgeId}`}>
            <polyline
              points={route.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={style.stroke}
              strokeOpacity={Math.min(1, style.opacity + 0.35)}
              strokeWidth={display.count > 1 ? 3 : 2}
              strokeDasharray={style.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {arrowHead(route, `focus-arrow:${edgeId}`, style.stroke, 0.9)}
          </g>
        );
      })}
    </svg>
  );
});
