"use client";
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";
import { cn } from "@multica/ui/lib/utils";
import type { DagVisibleEdge } from "./dag-projection";
import type { DagPoint } from "./dag-layout";
import { dagRouteMidpoint, dagRoutePath } from "./dag-route";
import { useT } from "../../i18n";

export type DagFlowEdgeData = {
  model: DagVisibleEdge;
  aggregate: boolean;
  focused: boolean;
  route: readonly DagPoint[];
  onSelect: (id: string) => void;
};
export type DagFlowEdge = Edge<DagFlowEdgeData, "dagEdge">;
export const DagFlowEdgeLine = memo(function DagFlowEdgeLine({
  id,
  data,
  selected,
  markerEnd,
}: EdgeProps<DagFlowEdge>) {
  const { t } = useT("issues");
  if (!data?.route.length) return null;
  const path = dagRoutePath(data.route),
    label = dagRouteMidpoint(data.route);
  const count = data.model.sourceEdgeIds.length;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        className={cn(
          "stroke-muted-foreground/65",
          data.focused && "stroke-brand",
          (selected || data.focused) && "!stroke-2",
        )}
        style={{
          stroke: selected || data.focused ? "var(--brand)" : "var(--muted-foreground)",
          strokeWidth: selected || data.focused ? 2 : 1.4,
          opacity: selected || data.focused ? 1 : 0.7,
          strokeDasharray: data.aggregate ? "6 3" : undefined,
        }}
      />
      {data.aggregate && count > 1 && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan pointer-events-auto absolute z-10 rounded-md border bg-card px-1.5 py-0.5 text-micro text-muted-foreground shadow-xs hover:border-brand focus-visible:outline-brand"
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px,${label.y}px)` }}
            aria-label={t(($) => $.dag.edge_count, { count })}
            onClick={() => data.onSelect(id)}
          >
            {t(($) => $.dag.edge_count, { count })}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
