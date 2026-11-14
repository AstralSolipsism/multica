"use client";

import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Ban,
  AlertTriangle,
  ShieldOff,
  RotateCw,
  Webhook,
} from "@multica/ui/icons";
import { useQuery } from "@tanstack/react-query";
import {
  autopilotDeliveriesOptions,
  autopilotDeliveryOptions,
  useReplayAutopilotDelivery,
} from "@multica/core/autopilots";
import { useWorkspaceId } from "@multica/core/hooks";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Badge } from "@multica/ui/components/ui/badge";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { useLocale, useT } from "../../i18n";
import { ObjectSection, ObjectSectionCard, ObjectSectionEmpty } from "../../layout/object-page";
import { DeliveryDetailDialog as SharedDeliveryDetailDialog } from "../../message-delivery/components/delivery-detail-dialog";
import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookSignatureStatus,
} from "@multica/core/types";

// --- Status visuals -------------------------------------------------------

// Mapping is exhaustive over the current backend enum but every consumer
// site falls back to a generic "unknown" visual when the server adds a new
// value — see the API Response Compatibility rules in CLAUDE.md.
type StatusVisual = {
  color: string;
  icon: typeof CheckCircle2;
  spin?: boolean;
};

const STATUS_VISUAL: Record<WebhookDeliveryStatus, StatusVisual> = {
  queued: { color: "text-info", icon: Loader2, spin: true },
  dispatched: { color: "text-success", icon: CheckCircle2 },
  // Signature failures and pre-flight bouncebacks land here. Read as a
  // failure visually, the dialog footer explains the reason.
  rejected: { color: "text-destructive", icon: ShieldOff },
  // Ignored covers paused/disabled/archived autopilots — same payload was
  // received but no run was created. Muted so it doesn't look like a bug.
  ignored: { color: "text-muted-foreground", icon: Ban },
  failed: { color: "text-destructive", icon: XCircle },
};

const UNKNOWN_VISUAL: StatusVisual = {
  color: "text-muted-foreground",
  icon: AlertTriangle,
};

function visualForStatus(status: string): StatusVisual {
  return (STATUS_VISUAL as Record<string, StatusVisual>)[status] ?? UNKNOWN_VISUAL;
}

// --- Helpers --------------------------------------------------------------

function formatDate(value: string, locale: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A delivery is replayable when (a) the server allows it (signature is not
// invalid AND the delivery itself wasn't rejected) and (b) we have something
// to replay (raw_body / received). We mirror the server's rule rather than
// rely on the response — keeping the button disabled saves a 400 round-trip.
function canReplay(delivery: WebhookDelivery): boolean {
  if (delivery.signature_status === "invalid") return false;
  if (delivery.status === "rejected") return false;
  // `queued` deliveries are mid-flight on the server; replay would race the
  // synchronous dispatch path. Once they settle, the user can replay.
  if (delivery.status === "queued") return false;
  return true;
}

// --- Section --------------------------------------------------------------

export function WebhookDeliveriesSection({
  autopilotId,
  hasWebhookTrigger,
}: {
  autopilotId: string;
  hasWebhookTrigger: boolean;
}) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();

  const { data: deliveries = [], isLoading } = useQuery(
    autopilotDeliveriesOptions(wsId, autopilotId, {
      enabled: hasWebhookTrigger,
    }),
  );

  // No webhook trigger configured → the entire section is irrelevant. We hide
  // it rather than render an empty card to keep the detail page short for
  // schedule-only autopilots.
  if (!hasWebhookTrigger) return null;

  return (
    <ObjectSection
      title={t(($) => $.deliveries.section_title)}
      count={isLoading ? undefined : deliveries.length}
    >
      {isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : deliveries.length === 0 ? (
        <ObjectSectionEmpty icon={Webhook} description={t(($) => $.deliveries.empty)} />
      ) : (
        <ObjectSectionCard>
          {deliveries.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              autopilotId={autopilotId}
            />
          ))}
        </ObjectSectionCard>
      )}
    </ObjectSection>
  );
}

// --- Row ------------------------------------------------------------------

function DeliveryRow({
  delivery,
  autopilotId,
}: {
  delivery: WebhookDelivery;
  autopilotId: string;
}) {
  const { t } = useT("autopilots");
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  const visual = visualForStatus(delivery.status);
  const StatusIcon = visual.icon;
  const statusLabel =
    t(($) => $.deliveries.status[delivery.status as WebhookDeliveryStatus]) ??
    delivery.status;
  const providerLabel = delivery.provider || "—";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-10 w-full items-center gap-3 px-3 py-2 text-left text-body hover:bg-accent/30 transition-colors"
      >
        <StatusIcon
          className={cn(
            "h-4 w-4 shrink-0",
            visual.color,
            visual.spin && "animate-spin",
          )}
        />
        <span className={cn("w-24 shrink-0 text-caption font-medium", visual.color)}>
          {statusLabel}
        </span>
        <span className="w-20 shrink-0 text-caption text-muted-foreground truncate">
          {providerLabel}
        </span>
        <span className="flex-1 min-w-0 text-caption text-muted-foreground truncate font-mono">
          {delivery.event || t(($) => $.webhook_payload.unknown_event)}
        </span>
        {delivery.replayed_from_delivery_id && (
          <Badge variant="secondary" className="shrink-0">
            <RotateCw className="h-3 w-3" />
            {t(($) => $.deliveries.row.replay_badge)}
          </Badge>
        )}
        {delivery.attempt_count > 1 && (
          <Badge variant="outline" className="shrink-0">
            {t(($) => $.deliveries.row.attempts, {
              count: delivery.attempt_count,
            })}
          </Badge>
        )}
        <span className="w-32 shrink-0 text-right text-caption text-muted-foreground tabular-nums">
          {formatDate(delivery.received_at || delivery.created_at, locale)}
        </span>
      </button>
      {open && (
        <DeliveryDetailDialog
          open={open}
          onOpenChange={setOpen}
          autopilotId={autopilotId}
          delivery={delivery}
        />
      )}
    </>
  );
}

// --- Detail dialog --------------------------------------------------------

function DeliveryDetailDialog({
  open,
  onOpenChange,
  autopilotId,
  delivery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autopilotId: string;
  delivery: WebhookDelivery;
}) {
  const { t } = useT("autopilots");
  const locale = useLocale();
  const wsId = useWorkspaceId();
  const replay = useReplayAutopilotDelivery();
  const { data: detail, isLoading } = useQuery(
    autopilotDeliveryOptions(wsId, autopilotId, delivery.id, { enabled: open }),
  );
  const full = detail ?? delivery;
  const visual = visualForStatus(full.status);

  const handleReplay = async () => {
    try {
      await replay.mutateAsync({ autopilotId, deliveryId: full.id });
      toast.success(t(($) => $.deliveries.replay.toast_success));
      onOpenChange(false);
    } catch (e: unknown) {
      const message =
        e instanceof Error
          ? e.message
          : t(($) => $.deliveries.replay.toast_failed);
      toast.error(message);
    }
  };

  const replayHint = full.signature_status === "invalid"
    ? t(($) => $.deliveries.replay.disabled_invalid_signature)
    : full.status === "rejected"
      ? t(($) => $.deliveries.replay.disabled_rejected)
      : full.status === "queued"
        ? t(($) => $.deliveries.replay.disabled_queued)
        : undefined;

  return (
    <SharedDeliveryDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl max-h-[85vh] overflow-y-auto"
      variant="webhook"
      title={t(($) => $.deliveries.detail.title)}
      status={{
        icon: visual.icon,
        color: visual.color,
        spin: visual.spin,
        label: t(($) => $.deliveries.status[full.status as WebhookDeliveryStatus]) ?? full.status,
        labelClassName: visual.color,
      }}
      badge={full.provider || "—"}
      headerExtras={<>
        <code className="rounded-xs bg-muted px-2 py-0.5 text-caption font-mono">
          {full.event || t(($) => $.webhook_payload.unknown_event)}
        </code>
        <SignatureBadge status={full.signature_status as WebhookSignatureStatus} />
      </>}
      metaTooltips
      meta={[
        { label: t(($) => $.deliveries.detail.received_at), value: formatDate(full.received_at, locale) },
        { label: t(($) => $.deliveries.detail.last_attempt_at), value: formatDate(full.last_attempt_at, locale) },
        { label: t(($) => $.deliveries.detail.attempt_count), value: String(full.attempt_count) },
        { label: t(($) => $.deliveries.detail.dispatch_attempts), value: String(full.dispatch_attempts) },
        ...(full.status === "queued" ? [{
          label: t(($) => $.deliveries.detail.available_at),
          value: formatDate(full.available_at, locale),
        }] : []),
        {
          label: t(($) => $.deliveries.detail.response_status),
          value: full.response_status != null ? String(full.response_status) : "—",
        },
        { label: t(($) => $.deliveries.detail.dedupe_key), value: full.dedupe_key ?? "—", mono: true },
        { label: t(($) => $.deliveries.detail.dedupe_source), value: full.dedupe_source ?? "—" },
        ...(full.content_type ? [{
          label: t(($) => $.deliveries.detail.content_type),
          value: full.content_type,
          mono: true,
        }] : []),
        ...(full.replayed_from_delivery_id ? [{
          label: t(($) => $.deliveries.detail.replayed_from),
          value: full.replayed_from_delivery_id,
          mono: true,
        }] : []),
      ]}
      error={full.error ? {
        label: t(($) => $.deliveries.detail.error_label),
        message: full.error,
      } : undefined}
      codeBlocksLoading={isLoading && !detail}
      codeBlocks={detail ? [
        ...(detail.raw_body ? [{
          label: t(($) => $.deliveries.detail.raw_body),
          value: detail.raw_body,
        }] : []),
        ...(detail.selected_headers && Object.keys(detail.selected_headers).length > 0 ? [{
          label: t(($) => $.deliveries.detail.selected_headers),
          value: JSON.stringify(detail.selected_headers, null, 2),
        }] : []),
        ...(detail.response_body ? [{
          label: t(($) => $.deliveries.detail.response_body),
          value: detail.response_body,
        }] : []),
      ] : undefined}
      action={{
        hint: replayHint,
        label: t(($) => $.deliveries.replay.action),
        pendingLabel: t(($) => $.deliveries.replay.in_progress),
        pending: replay.isPending,
        disabled: !canReplay(full) || replay.isPending,
        onClick: handleReplay,
      }}
    />
  );
}



function SignatureBadge({ status }: { status: WebhookSignatureStatus | string }) {
  const { t } = useT("autopilots");
  let variant: "default" | "secondary" | "destructive" | "outline" = "outline";
  if (status === "valid") variant = "default";
  else if (status === "invalid") variant = "destructive";
  else if (status === "missing") variant = "secondary";
  return (
    <Badge variant={variant}>
      {t(($) => $.deliveries.signature[status as WebhookSignatureStatus]) ?? status}
    </Badge>
  );
}
