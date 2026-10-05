import type { IssueGraph } from "@multica/core/api";
import { AlertTriangle, Expand, ListTree, Loader2, Shrink } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";

export function DagToolbar({
  graph,
  pending,
  layoutPendingLong,
  cancelPendingLayout,
  expandAll,
  collapseAll,
  collapsedIds,
  expandedIds,
}: {
  graph: IssueGraph;
  pending: boolean;
  layoutPendingLong: boolean;
  cancelPendingLayout: () => void;
  expandAll: () => void;
  collapseAll: () => void;
  collapsedIds: string[];
  expandedIds: string[];
}) {
  const { t: tDag } = useT("dag");
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-caption text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <ListTree className="size-3.5" />
        <span className="tabular-nums">
          {tDag(($) => $.summary_matches, { count: graph.matchedCount })}
        </span>
        {graph.contextCount > 0 && (
          <span className="tabular-nums">
            {tDag(($) => $.summary_context, { count: graph.contextCount })}
          </span>
        )}
        <span className="tabular-nums">
          {tDag(($) => $.summary_edges, { count: graph.edges.length })}
        </span>
      </span>
      {graph.hasRestrictedContext && (
        <span className="inline-flex items-center gap-1 text-warning">
          <AlertTriangle className="size-3" />
          {tDag(($) => $.restricted_context_hint)}
        </span>
      )}
      {graph.matchedCount === 0 && graph.contextCount > 0 && (
        <span>{tDag(($) => $.context_only_hint)}</span>
      )}
      <span className="inline-flex items-center gap-3 text-micro">
        <span>{tDag(($) => $.stage_legend)}</span>
        <span>{tDag(($) => $.dependency_legend)}</span>
      </span>
      <span className="ml-auto flex items-center gap-1">
        {pending && (
          <span className="inline-flex items-center gap-1.5" role="status">
            <Loader2 className="size-3 animate-spin" />
            {tDag(($) => $.layout_pending)}
            {layoutPendingLong && (
              <Button size="sm" variant="ghost" onClick={cancelPendingLayout}>
                {tDag(($) => $.layout_cancel)}
              </Button>
            )}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={expandAll}
          disabled={collapsedIds.length === 0}
        >
          <Expand className="size-3.5" />
          {tDag(($) => $.expand_all)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={collapseAll}
          disabled={expandedIds.length === 0}
        >
          <Shrink className="size-3.5" />
          {tDag(($) => $.collapse_all)}
        </Button>
      </span>
    </div>
  );
}
