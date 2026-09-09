"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { messageDeliveriesInfiniteOptions } from "@multica/core/message-delivery";
import { useWorkspaceId } from "@multica/core/hooks";
import type { MessageDelivery } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { messageDeliveryStatusKey } from "../copy";
import { deliveryStatusVisual } from "../status-visual";

/**
 * Per-run delivery indicators inside the automation's Run History rows
 * (R3/R5): each run queries ITS deliveries by run_id (server contract from
 * b5c87987 — the `applied_run_id` echo proves the filter was applied), shows
 * up to three status badges and a "+N" overflow. Opening anything — a single
 * delivery or the per-run list — is delegated UP via callbacks so the
 * dialogs render outside the run row's AppLink subtree (no portal-bubbled
 * navigation).
 *
 * A server that ignores run_id (older than the R3 contract) answers 200
 * without a matching echo: the badge renders an explicit unsupported marker
 * instead of claiming the run has no deliveries.
 */
export function RunDeliveryBadges({
  autopilotId,
  runId,
  onOpenDelivery,
  onOpenRunList,
}: {
  autopilotId: string;
  runId: string;
  onOpenDelivery: (delivery: MessageDelivery) => void;
  onOpenRunList: (runId: string) => void;
}) {
  const { t } = useT("message-delivery");
  const wsId = useWorkspaceId();
  const query = useInfiniteQuery(
    messageDeliveriesInfiniteOptions(wsId, autopilotId, { runId }),
  );

  // Read-only callers get a real 403; badges stay silent there.
  if (query.isError) return null;

  const firstPage = query.data?.pages[0];
  if (firstPage && firstPage.applied_run_id !== runId) {
    return (
      <span
        className="shrink-0 text-micro text-muted-foreground"
        title={t(($) => $.deliveries.run_filter_unsupported)}
      >
        {t(($) => $.deliveries.run_filter_unsupported)}
      </span>
    );
  }

  const rows = (query.data?.pages ?? []).flatMap((page) => page.deliveries);
  if (rows.length === 0) return null;

  const shown = rows.slice(0, 3);
  const overflow = rows.length - shown.length;

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {shown.map((d) => {
        const visual = deliveryStatusVisual(d.status);
        const StatusIcon = visual.icon;
        const statusLabel = t(
          ($) => $.deliveries.status[messageDeliveryStatusKey(d.status)],
        );
        return (
          <button
            key={d.id}
            type="button"
            title={statusLabel}
            aria-label={`${t(($) => $.deliveries.row.open_delivery)}: ${statusLabel}`}
            onClick={(e) => {
              // The run row itself may be an AppLink (create_issue mode) —
              // the badge must not trigger that navigation.
              e.preventDefault();
              e.stopPropagation();
              onOpenDelivery(d);
            }}
            className="rounded p-0.5 hover:bg-accent transition-colors"
          >
            <StatusIcon
              className={cn("h-3.5 w-3.5", visual.color, visual.spin && "animate-spin")}
            />
          </button>
        );
      })}
      {overflow > 0 && (
        <button
          type="button"
          aria-label={t(($) => $.deliveries.row.open_run_deliveries)}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenRunList(runId);
          }}
          className="rounded px-1 py-0.5 text-micro text-muted-foreground hover:bg-accent hover:text-foreground transition-colors tabular-nums"
        >
          +{overflow}
        </button>
      )}
    </span>
  );
}
