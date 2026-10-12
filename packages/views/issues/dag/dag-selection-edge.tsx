"use client";

import { ChevronDown, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { useViewStoreApi } from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";
import type { DagVisibleEdge } from "@multica/core/issues/dag";

/** The selection zone's edge state: a direct dependency gets its label,
 *  locate and clear; an aggregate opens the original pair list from the bar. */
export function DagEdgeSelection({
  edge,
  aggregate,
  hasReverse,
  nodeLabelById,
  issueLabelById,
  onLocate,
  onOpenIssue,
}: {
  edge: DagVisibleEdge;
  aggregate: boolean;
  hasReverse: boolean;
  nodeLabelById: ReadonlyMap<string, string>;
  issueLabelById: ReadonlyMap<string, string>;
  onLocate: (issueIds: string[]) => void;
  onOpenIssue: (issueId: string) => void;
}) {
  const { t } = useT("dag");
  const storeApi = useViewStoreApi();
  const label = t(($) => $.edge_label, {
    source: nodeLabelById.get(edge.source) ?? "",
    target: nodeLabelById.get(edge.target) ?? "",
  });
  return (
    <>
      <span
        className="max-w-64 shrink truncate px-1 text-caption font-medium text-foreground"
        title={label}
      >
        {label}
      </span>
      {aggregate ? (
        <Popover>
          <PopoverTrigger
            render={<Button size="sm" variant="ghost" className="gap-1" />}
          >
            {t(($) => $.edge_aggregate_summary, { count: edge.sourceEdgeIds.length })}
            <ChevronDown className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[26rem] max-w-[80vw] p-2">
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {edge.sources.map((source) => (
                <li
                  key={source.edgeId}
                  className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-caption hover:bg-muted/60"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
                    onClick={() => onOpenIssue(source.source)}
                    title={issueLabelById.get(source.source)}
                  >
                    {issueLabelById.get(source.source) ?? "?"}
                  </button>
                  <span aria-hidden className="shrink-0 text-faint-foreground">
                    →
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
                    onClick={() => onOpenIssue(source.target)}
                    title={issueLabelById.get(source.target)}
                  >
                    {issueLabelById.get(source.target) ?? "?"}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => onLocate([source.source, source.target])}
                  >
                    {t(($) => $.edge_locate)}
                  </Button>
                </li>
              ))}
            </ul>
            {hasReverse && (
              <p className="mt-1 border-t px-1 pt-1.5 text-micro text-muted-foreground">
                {t(($) => $.edge_aggregate_bidirectional)}
              </p>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        edge.sources[0] && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onLocate([edge.sources[0]!.source, edge.sources[0]!.target])
            }
          >
            {t(($) => $.edge_locate)}
          </Button>
        )
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0"
        aria-label={t(($) => $.clear_selection)}
        onClick={() => storeApi.getState().setDagSelectedEdgeId(null)}
      >
        <X className="size-3.5" />
      </Button>
    </>
  );
}
