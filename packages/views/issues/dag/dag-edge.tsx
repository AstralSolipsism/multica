"use client";

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Position,
} from "@xyflow/react";
import { cn } from "@multica/ui/lib/utils";
import type { DagVisibleEdge } from "./dag-projection";

/** Display data for one canvas edge. Explanation content (original endpoints,
 *  bidirectional note) renders in the canvas inspector when the edge is
 *  selected; the edge itself only carries styling + the aggregate count. */
export type DagFlowEdgeData = {
  model: DagVisibleEdge;
  /** True when the edge summarizes folded members or merges several source
   *  edges — the count badge and inspector treat it as an aggregate. */
  aggregate: boolean;
  dimmed: boolean;
  focused: boolean;
};

export type DagFlowEdge = Edge<DagFlowEdgeData, "dagEdge">;

export const DagFlowEdgeLine = memo(function DagFlowEdgeLine({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps<DagFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition as Position,
    targetPosition: targetPosition as Position,
  });
  const count = data?.model.sourceEdgeIds.length ?? 1;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        className={cn(
          "stroke-border",
          data?.focused && "stroke-brand",
          (selected || data?.focused) && "!stroke-2",
          data?.dimmed && "opacity-25",
        )}
        style={{ strokeDasharray: data?.aggregate ? "6 3" : undefined }}
      />
      {data?.aggregate && count > 1 && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-none absolute rounded-full bg-muted px-1.5 py-0.5 text-micro font-medium",
              data.dimmed ? "text-faint-foreground" : "text-muted-foreground",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            ×{count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
