"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { workspaceIssueUsageOptions } from "@multica/core/issues/queries";
import { useViewStore } from "@multica/core/issues/stores/view-store-context";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import type { IssueUsageRow } from "@multica/core/types";
import { estimateCost, formatUsd } from "../../runtimes/utils";
import { useT } from "../../i18n";

/** Cache-only observers: IssueSurface owns the sole workspace fetch. */
export function IssueCostBadge({ issueIds }: { issueIds: string | readonly string[] }) {
  const wsId = useWorkspaceId();
  const visible = useViewStore((state) => state.cardProperties.cost);
  const pricings = useCustomPricingStore((state) => state.pricings);
  const { t } = useT("issues");
  const select = useCallback((byIssue: Partial<Record<string, IssueUsageRow[]>>) => {
    const ids = typeof issueIds === "string" ? [issueIds] : [...new Set(issueIds)];
    let cost: number | undefined;
    for (const id of ids) {
      for (const row of byIssue[id] ?? []) cost = (cost ?? 0) + estimateCost(row);
    }
    return cost;
    // estimateCost reads the custom pricing store; resubscribe when rates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueIds, pricings]);
  const { data: cost } = useQuery({
    ...workspaceIssueUsageOptions(wsId),
    enabled: false,
    select,
  });
  if (!visible || cost === undefined) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-xs bg-muted/60 px-1 py-0.5 text-micro font-medium text-muted-foreground tabular-nums"
      title={`${t(($) => $.display.card_cost)}: ${formatUsd(cost)}`}
    >
      {formatUsd(cost)}
    </span>
  );
}
