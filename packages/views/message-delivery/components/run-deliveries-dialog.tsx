"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { messageDeliveriesInfiniteOptions } from "@multica/core/message-delivery";
import { useWorkspaceId } from "@multica/core/hooks";
import type { MessageDelivery } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useLocale, useT } from "../../i18n";
import { messageDeliverySourceKindKey, messageDeliveryStatusKey } from "../copy";
import { deliveryStatusVisual } from "../status-visual";

/**
 * All deliveries of one automation run (R3 overflow entry). Rendered by the
 * run history host OUTSIDE any AppLink subtree, so clicks here can never
 * bubble into a task navigation. Rows open the shared delivery detail via
 * the `onOpenDelivery` callback.
 */
export function RunDeliveriesDialog({
  open,
  onOpenChange,
  autopilotId,
  runId,
  onOpenDelivery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autopilotId: string;
  runId: string;
  onOpenDelivery: (delivery: MessageDelivery) => void;
}) {
  const { t } = useT("message-delivery");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const query = useInfiniteQuery({
    ...messageDeliveriesInfiniteOptions(wsId, autopilotId, { runId }),
    enabled: open,
  });

  const rows = (query.data?.pages ?? []).flatMap((page) => page.deliveries);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogTitle>{t(($) => $.deliveries.run_dialog.title)}</DialogTitle>
        <div className="space-y-1 pt-1">
          {query.isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))
          ) : rows.length === 0 ? (
            <p className="text-body text-muted-foreground">
              {t(($) => $.deliveries.empty)}
            </p>
          ) : (
            rows.map((d) => {
              const visual = deliveryStatusVisual(d.status);
              const StatusIcon = visual.icon;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onOpenDelivery(d)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-body hover:bg-accent/30 transition-colors"
                >
                  <StatusIcon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      visual.color,
                      visual.spin && "animate-spin",
                    )}
                  />
                  <span className="w-24 shrink-0 text-caption font-medium text-foreground">
                    {t(($) => $.deliveries.status[messageDeliveryStatusKey(d.status)])}
                  </span>
                  <span className="w-24 shrink-0 text-caption text-muted-foreground">
                    {t(($) => $.deliveries.source_kind[messageDeliverySourceKindKey(d.source_kind)])}
                  </span>
                  <span className="flex-1 min-w-0 truncate font-mono text-caption text-muted-foreground">
                    {d.target_key}
                  </span>
                  <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                    {new Date(d.created_at).toLocaleString(locale, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </button>
              );
            })
          )}
          {query.hasNextPage === true && (
            <div className="flex justify-center pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {t(($) => $.deliveries.load_more)}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
