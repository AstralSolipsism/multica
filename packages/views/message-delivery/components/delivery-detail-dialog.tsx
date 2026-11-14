"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, RotateCw, Send, Webhook } from "@multica/ui/icons";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { TruncatedTooltip } from "@multica/ui/components/common/truncated-tooltip";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import type {
  MessageDeliveryReceipt,
  MessageDeliveryTargetSnapshot,
} from "@multica/core/types";
import { useLocale, useT } from "../../i18n";
import { AppLink } from "../../navigation";

type Status = {
  icon: typeof Send;
  color: string;
  spin?: boolean;
  label: string;
  labelClassName: string;
};

type Content = {
  title: string;
  loading: boolean;
  emptyLabel: string;
  exists: boolean;
  summary?: string;
  change?: string;
  text?: string;
};

type Action = {
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  hint?: string;
};

type Confirmation = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
};

export function DeliveryDetailDialog({
  open,
  onOpenChange,
  className,
  variant,
  title,
  status,
  badge,
  headerExtras,
  issueLink,
  description,
  loadError,
  content,
  meta,
  metaTooltips = false,
  afterMeta,
  error,
  codeBlocks,
  codeBlocksLoading = false,
  receipts,
  receiptsLoading = false,
  action,
  confirmation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className: string;
  variant: "message" | "webhook";
  title: string;
  status: Status;
  badge: string;
  headerExtras?: ReactNode;
  issueLink?: { href: string; label: string };
  description?: string;
  loadError?: string;
  content?: Content;
  meta: { label: string; value: string; mono?: boolean }[];
  metaTooltips?: boolean;
  afterMeta?: ReactNode;
  error?: { label: string; message?: string | null };
  codeBlocks?: { label: string; value: string }[];
  codeBlocksLoading?: boolean;
  receipts?: MessageDeliveryReceipt[];
  receiptsLoading?: boolean;
  action: Action;
  confirmation?: Confirmation;
}) {
  const StatusIcon = status.icon;
  const TitleIcon = variant === "webhook" ? Webhook : Send;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogTitle className="flex items-center gap-2">
          <TitleIcon className="h-4 w-4 text-muted-foreground" />
          {title}
        </DialogTitle>
        <div className="space-y-4 pt-1">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <StatusIcon
                className={cn("h-4 w-4 shrink-0", status.color, status.spin && "animate-spin")}
              />
              <span className={cn("text-body font-medium", status.labelClassName)}>
                {status.label}
              </span>
            </div>
            <Badge variant="outline">{badge}</Badge>
            {headerExtras}
            {issueLink && (
              <AppLink
                href={issueLink.href}
                className="text-caption font-medium text-foreground underline underline-offset-2"
              >
                {issueLink.label}
              </AppLink>
            )}
          </div>

          {description && (
            <p className="text-caption text-muted-foreground">{description}</p>
          )}

          {loadError && (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          )}

          {!loadError && content && (
            <div className="min-w-0 rounded-md border bg-background">
              <div className="border-b px-3 py-1.5 text-micro font-medium text-muted-foreground">
                {content.title}
              </div>
              {content.loading ? (
                <div className="space-y-2 p-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : content.exists ? (
                <div className="space-y-2 p-3">
                  {content.summary && <p className="text-body">{content.summary}</p>}
                  {content.change && (
                    <p className="text-caption text-muted-foreground">{content.change}</p>
                  )}
                  {content.text ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted/40 px-3 py-2 text-caption font-mono leading-relaxed">
                      {content.text}
                    </pre>
                  ) : (
                    <p className="text-caption text-muted-foreground">
                      {content.emptyLabel}
                    </p>
                  )}
                </div>
              ) : (
                <p className="p-3 text-caption text-muted-foreground">
                  {content.emptyLabel}
                </p>
              )}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption">
            {meta.map((row) => (
              <MetaRow key={row.label} {...row} tooltip={metaTooltips} />
            ))}
          </dl>

          {afterMeta}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive">
              <div className="font-medium">{error.label}</div>
              {error.message && (
                <div className="mt-0.5 font-mono break-all">{error.message}</div>
              )}
            </div>
          )}

          {codeBlocksLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : codeBlocks ? (
            <div className="space-y-3">
              {codeBlocks.map((block) => (
                <CodeBlock key={block.label} {...block} />
              ))}
            </div>
          ) : null}

          {!loadError && receipts && (receiptsLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : receipts.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-micro font-medium text-muted-foreground">
                <ReceiptsLabel />
              </div>
              <div className="rounded-md border divide-y">
                {receipts.map((receipt) => (
                  <ReceiptRow key={receipt.id} receipt={receipt} />
                ))}
              </div>
            </div>
          ) : null)}

          <div className="flex items-center justify-between pt-2">
            {action.hint !== undefined && (
              <span className="text-caption text-muted-foreground">{action.hint}</span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={action.disabled}
              onClick={action.onClick}
            >
              <RotateCw
                className={cn("h-3.5 w-3.5 mr-1", action.pending && "animate-spin")}
              />
              {action.pending ? action.pendingLabel : action.label}
            </Button>
          </div>
        </div>

        {confirmation && (
          <AlertDialog open={confirmation.open} onOpenChange={confirmation.onOpenChange}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
                <AlertDialogDescription>{confirmation.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={action.pending}>
                  {confirmation.cancelLabel}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={confirmation.onConfirm}
                  disabled={confirmation.disabled}
                >
                  {action.pending ? action.pendingLabel : confirmation.confirmLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MetaRow({
  label,
  value,
  mono = false,
  tooltip,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tooltip: boolean;
}) {
  const valueClass = cn("truncate text-foreground", mono && "font-mono");
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      {tooltip ? (
        <TruncatedTooltip content={value} focusable>
          <dd className={valueClass}>{value}</dd>
        </TruncatedTooltip>
      ) : (
        <dd className={valueClass} title={value}>{value}</dd>
      )}
    </div>
  );
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  const { t } = useT("autopilots");
  const [copied, setCopied] = useState(false);
  const TRUNCATE_AT = 4096;
  const isTruncated = value.length > TRUNCATE_AT;
  const display = isTruncated ? value.slice(0, TRUNCATE_AT) : value;

  const handleCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      toast.success(t(($) => $.webhook_payload.copied));
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(t(($) => $.webhook_payload.copy_failed));
    }
  };

  return (
    <div className="min-w-0 rounded-md border bg-background">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-micro">
        <span className="font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded-xs px-2 py-0.5 hover:bg-accent transition-colors"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied
            ? t(($) => $.webhook_payload.copied_short)
            : t(($) => $.webhook_payload.copy)}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto bg-muted/40 px-3 py-2 text-caption font-mono leading-relaxed whitespace-pre-wrap break-all">
        {display}
        {isTruncated && (
          <span className="block pt-2 text-muted-foreground">
            {t(($) => $.webhook_payload.truncated_marker)}
          </span>
        )}
      </pre>
    </div>
  );
}

function ReceiptsLabel() {
  const { t } = useT("message-delivery");
  return t(($) => $.deliveries.detail.receipts);
}

function ReceiptRow({ receipt }: { receipt: MessageDeliveryReceipt }) {
  const { t } = useT("message-delivery");
  const locale = useLocale();
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-caption">
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {t(($) => $.deliveries.detail.receipt_shard, {
          index: receipt.shard_index + 1,
          total: receipt.shard_total,
        })}
      </span>
      <span className="flex-1 min-w-0 truncate font-mono">
        {receipt.external_message_id ?? "—"}
      </span>
      <span
        className="shrink-0 text-muted-foreground font-mono"
        title={`${t(($) => $.deliveries.detail.send_uuid)}: ${receipt.send_uuid}`}
      >
        {receipt.send_uuid.slice(0, 8)}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatDeliveryDate(receipt.created_at, locale)}
      </span>
    </div>
  );
}

export function formatDeliveryDate(value: string | null | undefined, locale: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function messageDeliveryTargetLabel(
  target: MessageDeliveryTargetSnapshot | null,
  fallbackKey: string,
  members: { user_id: string; name: string; email: string }[],
): string {
  if (!target) return fallbackKey || "—";
  switch (target.target_type) {
    case "member": {
      const member = members.find((m) => m.user_id === target.user_id);
      return member ? member.name || member.email : (target.user_id ?? fallbackKey);
    }
    case "group":
      return target.chat_id ?? fallbackKey;
    case "topic":
      return `${target.chat_id ?? "—"} ↳ ${target.message_id ?? "—"}`;
    default:
      return fallbackKey || "—";
  }
}
