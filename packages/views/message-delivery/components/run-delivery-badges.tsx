"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { messageDeliveriesOptions } from "@multica/core/message-delivery";
import { useWorkspaceId } from "@multica/core/hooks";
import type { MessageDelivery } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { messageDeliveryStatusKey } from "../copy";
import { deliveryStatusVisual } from "../status-visual";
import { DeliveryDetailDialog } from "./message-deliveries-section";

/**
 * Per-run delivery indicators inside the automation's Run History rows
 * (OL-26 review): each run shows the status of its push deliveries and
 * opens the delivery detail — report, receipts, retry — directly.
 *
 * Shares the unfiltered first-page records query with the deliveries
 * section, so mounting one badge per run costs no extra requests. The rows
 * are an entry point, not a second source of truth: anything beyond the
 * first page lives in the records section below.
 */
export function RunDeliveryBadges({
  autopilotId,
  runId,
  canWrite,
}: {
  autopilotId: string;
  runId: string;
  canWrite: boolean;
}) {
  const { t } = useT("message-delivery");
  const wsId = useWorkspaceId();
  const { data, isError } = useQuery(messageDeliveriesOptions(wsId, autopilotId));
  const [openDelivery, setOpenDelivery] = useState<MessageDelivery | null>(null);

  // Read-only callers get a real 403 from the records endpoint; the badges
  // stay silent there (the records section carries the restricted notice).
  if (isError) return null;

  const rows = (data?.deliveries ?? []).filter((d) => d.run_id === runId);
  if (rows.length === 0) return null;

  return (
    <>
      <span className="flex shrink-0 items-center gap-0.5">
        {rows.slice(0, 3).map((d) => {
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
                setOpenDelivery(d);
              }}
              className="rounded p-0.5 hover:bg-accent transition-colors"
            >
              <StatusIcon
                className={cn("h-3.5 w-3.5", visual.color, visual.spin && "animate-spin")}
              />
            </button>
          );
        })}
        {rows.length > 3 && (
          <span className="text-micro text-muted-foreground tabular-nums">
            +{rows.length - 3}
          </span>
        )}
      </span>
      {openDelivery && (
        <DeliveryDetailDialog
          open
          onOpenChange={(open) => {
            if (!open) setOpenDelivery(null);
          }}
          autopilotId={autopilotId}
          delivery={openDelivery}
          canWrite={canWrite}
        />
      )}
    </>
  );
}
