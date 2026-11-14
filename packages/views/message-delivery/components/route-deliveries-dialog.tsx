"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  messageRouteDeliveriesInfiniteOptions,
  messageRouteDeliveryOptions,
  messageSourceKeys,
  useRetryMessageRouteDelivery,
} from "@multica/core/message-delivery";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { errorCode } from "@multica/core/api";
import type { MessageSourceDelivery } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { useLocale, useT } from "../../i18n";
import { deliveryStatusVisual } from "../status-visual";
import {
  DeliveryDetailDialog as SharedDeliveryDetailDialog,
  formatDeliveryDate,
  messageDeliveryTargetLabel,
} from "./delivery-detail-dialog";
import {
  canRetryMessageDelivery,
  messageDeliveryErrorCodeKey,
  messageDeliveryErrorKey,
  messageDeliverySourceKindKey,
  messageDeliveryStatusKey,
} from "../copy";



const FILTER_STATUSES = [
  "queued",
  "sending",
  "sent",
  "failed",
  "uncertain",
  "cancelled",
  "suppressed",
] as const;

/**
 * Records for one personal/team route. Offset-paged at a fixed legal page
 * size; the query polls fast while any row is in flight because worker
 * write-backs emit no websocket events. Errors (permission revoked, route
 * deleted, request failure) render as explicit alerts — never as an empty
 * list.
 */
export function RouteDeliveriesDialog({
  open,
  onOpenChange,
  routeId,
  canManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routeId: string;
  canManage: boolean;
}) {
  const { t } = useT("message-delivery");
  const wsId = useWorkspaceId();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const deliveriesQuery = useInfiniteQuery(
    messageRouteDeliveriesInfiniteOptions(
      wsId,
      routeId,
      { status: statusFilter === "all" ? undefined : statusFilter },
      { enabled: open },
    ),
  );

  const deliveries = deliveriesQuery.data?.pages.flatMap((page) => page.deliveries) ?? [];
  const detail = detailId ? deliveries.find((d) => d.id === detailId) ?? null : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
          onOpenChange(o);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogTitle>{t(($) => $.deliveries.route_dialog.title)}</DialogTitle>
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-caption text-muted-foreground">
              {t(($) => $.deliveries.description)}
            </p>
            <Select
              items={[
                { value: "all", label: t(($) => $.deliveries.filter_all) },
                ...FILTER_STATUSES.map((s) => ({
                  value: s,
                  label: t(($) => $.deliveries.status[s]),
                })),
              ]}
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as string)}
            >
              <SelectTrigger size="sm" aria-label={t(($) => $.deliveries.title)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t(($) => $.deliveries.filter_all)}</SelectItem>
                {FILTER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(($) => $.deliveries.status[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {deliveriesQuery.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t(($) => $.error[messageDeliveryErrorKey(errorCode(deliveriesQuery.error))])}
              </AlertDescription>
            </Alert>
          ) : deliveriesQuery.isLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : deliveries.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
              {t(($) => $.deliveries.empty)}
            </div>
          ) : (
            <>
              <div className="rounded-md border overflow-hidden divide-y">
                {deliveries.map((delivery) => (
                  <button
                    key={delivery.id}
                    type="button"
                    onClick={() => setDetailId(delivery.id)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-body hover:bg-accent/30 transition-colors"
                  >
                    <DeliveryRowBody delivery={delivery} />
                  </button>
                ))}
              </div>
              {deliveriesQuery.hasNextPage === true && (
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => deliveriesQuery.fetchNextPage()}
                    disabled={deliveriesQuery.isFetchingNextPage}
                  >
                    {t(($) => $.deliveries.load_more)}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
      </Dialog>
      {/* The detail dialog is a SIBLING portal, not nested inside the list
          dialog's content — nested dialogs fight over focus trapping. */}
      {detail && (
        <SourceDeliveryDetailDialog
          open={detail != null}
          onOpenChange={(o) => {
            if (!o) setDetailId(null);
          }}
          routeId={routeId}
          delivery={detail}
          canManage={canManage}
        />
      )}
    </>
  );
}

function DeliveryRowBody({ delivery }: { delivery: MessageSourceDelivery }) {
  const { t } = useT("message-delivery");
  const locale = useLocale();
  const visual = deliveryStatusVisual(delivery.status);
  const StatusIcon = visual.icon;
  return (
    <>
      <StatusIcon
        className={cn("h-4 w-4 shrink-0", visual.color, visual.spin && "animate-spin")}
      />
      <span className="w-24 shrink-0 text-caption font-medium text-foreground">
        {t(($) => $.deliveries.status[messageDeliveryStatusKey(delivery.status)])}
      </span>
      <span className="w-28 shrink-0 text-caption text-muted-foreground truncate">
        {t(($) => $.deliveries.source_kind[messageDeliverySourceKindKey(delivery.source_kind)])}
      </span>
      <span className="flex-1 min-w-0 text-caption text-muted-foreground truncate font-mono">
        {delivery.target_key}
      </span>
      {delivery.shard_total > 1 && (
        <Badge variant="outline" className="shrink-0">
          {t(($) => $.deliveries.row.shards, {
            done: delivery.status === "sent" ? delivery.shard_total : 0,
            total: delivery.shard_total,
          })}
        </Badge>
      )}
      {delivery.attempts > 1 && (
        <Badge variant="outline" className="shrink-0">
          {t(($) => $.deliveries.row.attempts, { count: delivery.attempts })}
        </Badge>
      )}
      <span className="w-32 shrink-0 text-right text-caption text-muted-foreground tabular-nums">
        {formatDeliveryDate(delivery.delivered_at ?? delivery.created_at, locale)}
      </span>
    </>
  );
}

/**
 * Source-delivery detail: the frozen content/target snapshots, the
 * source-record locator (a locator, never a grant), the per-shard receipt
 * ledger and the permission-gated retry. Retry is offered only for
 * failed/uncertain rows; uncertain requires an explicit verify-first confirm.
 */
export function SourceDeliveryDetailDialog({
  open,
  onOpenChange,
  routeId,
  delivery,
  canManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routeId: string;
  delivery: MessageSourceDelivery;
  canManage: boolean;
}) {
  const { t } = useT("message-delivery");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const retry = useRetryMessageRouteDelivery();
  const [confirmUncertain, setConfirmUncertain] = useState(false);

  const { data: detail, isLoading, isFetching, isError, error } = useQuery(
    messageRouteDeliveryOptions(wsId, routeId, delivery.id, { enabled: open }),
  );
  const detailError = isError ? error : null;

  // A newer list row means the cached detail may have stale retry state.
  const qc = useQueryClient();
  useEffect(() => {
    if (detail && delivery.updated_at && detail.delivery.updated_at !== delivery.updated_at) {
      qc.invalidateQueries({
        queryKey: messageSourceKeys.delivery(wsId, routeId, delivery.id),
      });
    }
  }, [qc, wsId, routeId, delivery.id, delivery.updated_at, detail]);

  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const full = detail?.delivery ?? delivery;
  const visual = deliveryStatusVisual(full.status);
  const content = detail?.content_snapshot ?? null;
  const target = detail?.target_snapshot ?? null;
  const sourceRef = detail?.source_ref ?? null;
  const receipts = detail?.receipts ?? [];

  // Retry is available only from a completed current detail read, never a stale row.
  const detailReady = detail != null && !isFetching && detailError == null;
  const retryable =
    canManage &&
    detail != null &&
    !isFetching &&
    detailError == null &&
    canRetryMessageDelivery(detail.delivery.status);
  const canSubmitRetry = retryable && !retry.isPending;

  const handleRetry = () => {
    // Re-check when either retry action is clicked, including an open confirmation.
    if (!canSubmitRetry || detail == null) return;
    retry.mutate(
      { routeId, deliveryId: detail.delivery.id },
      {
        onSuccess: () => {
          toast.success(t(($) => $.deliveries.retry.toast));
          setConfirmUncertain(false);
        },
        onError: (e) => {
          toast.error(t(($) => $.error[messageDeliveryErrorKey(errorCode(e))]));
        },
      },
    );
  };

  return (
    <SharedDeliveryDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
      variant="message"
      title={t(($) => $.deliveries.detail.title)}
      status={{
        icon: visual.icon,
        color: visual.color,
        spin: visual.spin,
        label: t(($) => $.deliveries.status[messageDeliveryStatusKey(full.status)]),
        labelClassName: "text-foreground",
      }}
      badge={t(($) => $.deliveries.source_kind[messageDeliverySourceKindKey(full.source_kind)])}
      issueLink={sourceRef?.issue_identifier ? {
        href: wsPaths.issueDetail(sourceRef.issue_identifier),
        label: `${t(($) => $.deliveries.detail.view_issue)} ${sourceRef.issue_identifier}`,
      } : undefined}
      description={full.status === "sent" ? t(($) => $.deliveries.description) : undefined}
      loadError={detailError
        ? t(($) => $.error[messageDeliveryErrorKey(errorCode(detailError))])
        : undefined}
      content={{
        title: t(($) => $.deliveries.detail.content),
        loading: isLoading && !detail,
        emptyLabel: t(($) => $.deliveries.detail.no_report_body),
        exists: content != null,
        summary: content?.summary,
        change: content?.change,
        text: content?.text ?? content?.body,
      }}
      meta={[
        {
          label: t(($) => $.deliveries.detail.target),
          value: messageDeliveryTargetLabel(target, full.target_key, members),
          mono: target?.target_type !== "member",
        },
        { label: t(($) => $.deliveries.detail.created_at), value: formatDeliveryDate(full.created_at, locale) },
        { label: t(($) => $.deliveries.detail.first_attempt_at), value: formatDeliveryDate(full.first_attempt_at, locale) },
        { label: t(($) => $.deliveries.detail.delivered_at), value: formatDeliveryDate(full.delivered_at, locale) },
        { label: t(($) => $.deliveries.detail.next_attempt_at), value: formatDeliveryDate(full.next_attempt_at, locale) },
        { label: t(($) => $.deliveries.detail.attempts), value: String(full.attempts) },
        { label: t(($) => $.deliveries.detail.route_revision), value: `v${full.route_revision}` },
      ]}
      error={full.error_code ? {
        label: t(($) => $.error_code[messageDeliveryErrorCodeKey(full.error_code)]),
        message: full.last_error,
      } : undefined}
      receipts={receipts}
      receiptsLoading={isLoading && !detail}
      action={{
        hint: retryable
          ? ""
          : detailError
            ? t(($) => $.deliveries.detail.load_failed)
            : !detailReady
              ? t(($) => $.deliveries.detail.loading_state)
              : !canManage && canRetryMessageDelivery(full.status)
                ? t(($) => $.section.read_only)
                : t(($) => $.deliveries.retry.disabled),
        label: t(($) => $.deliveries.retry.action),
        pendingLabel: t(($) => $.deliveries.retry.in_progress),
        pending: retry.isPending,
        disabled: !canSubmitRetry,
        onClick: () => {
          if (full.status === "uncertain") setConfirmUncertain(true);
          else handleRetry();
        },
      }}
      confirmation={{
        open: confirmUncertain,
        onOpenChange: setConfirmUncertain,
        title: t(($) => $.deliveries.retry.uncertain_title),
        description: t(($) => $.deliveries.retry.uncertain_description),
        cancelLabel: t(($) => $.deliveries.retry.cancel),
        confirmLabel: t(($) => $.deliveries.retry.uncertain_confirm),
        disabled: !canSubmitRetry,
        onConfirm: handleRetry,
      }}
    />
  );
}
