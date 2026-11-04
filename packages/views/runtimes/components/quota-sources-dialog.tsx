"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "@multica/ui/icons";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Switch } from "@multica/ui/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import type { QuotaSource } from "@multica/core/api";
import {
  formatCompactDuration,
  isCollectorObservationInterrupted,
  quotaSourceListOptions,
  useDeleteQuotaSource,
  useRefreshQuotaSource,
  useUpdateQuotaSource,
} from "@multica/core/runtimes";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { QuotaSourceForm } from "./quota-source-form";
import {
  QuotaSourceIcon,
  quotaSourceActionError,
  quotaSourceErrorLabel,
  quotaSourceKindLabel,
} from "./quota-source-shared";

export function quotaSourceRefreshCooldownSeconds(
  source: Pick<QuotaSource, "last_polled_at">,
  now: number,
): number {
  if (!source.last_polled_at) return 0;
  const polledAt = Date.parse(source.last_polled_at);
  if (!Number.isFinite(polledAt)) return 0;
  return Math.max(0, Math.ceil((30_000 - (now - polledAt)) / 1000));
}

type DialogView = { name: "list" } | { name: "form"; source: QuotaSource | null };

export function QuotaSourcesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("runtimes");
  const { t: tQuota } = useT("quota");
  const sourcesQuery = useQuery(quotaSourceListOptions());
  const updateSource = useUpdateQuotaSource();
  const refreshSource = useRefreshQuotaSource();
  const deleteSource = useDeleteQuotaSource();
  const [view, setView] = useState<DialogView>({ name: "list" });
  const [deleting, setDeleting] = useState<QuotaSource | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  const sources = sourcesQuery.data?.sources ?? [];
  const listBusy = updateSource.isPending || refreshSource.isPending || deleteSource.isPending;
  const handleOpenChange = (next: boolean) => {
    if (!next && (formSaving || listBusy)) return;
    onOpenChange(next);
    if (!next) {
      setView({ name: "list" });
      setDeleting(null);
      setActionError(null);
    }
  };
  const showForm = (source: QuotaSource | null) => {
    setActionError(null);
    setView({ name: "form", source });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]">
          {view.name === "form" ? (
            <QuotaSourceForm
              key={view.source?.id ?? "new"}
              source={view.source}
              encryptionConfigured={sourcesQuery.data?.encryption_configured !== false}
              onBack={() => setView({ name: "list" })}
              onSaved={() => setView({ name: "list" })}
              onSavingChange={setFormSaving}
            />
          ) : (
            <>
              <DialogHeader className="shrink-0 px-5 pb-3 pt-5 pr-12">
                <DialogTitle>{t(($) => $.quota_sources.dialog.title)}</DialogTitle>
                <DialogDescription>
                  {t(($) => $.quota_sources.dialog.description)}
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
                {actionError && (
                  <div role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-caption text-destructive">
                    {actionError}
                  </div>
                )}
                {sourcesQuery.isPending ? (
                  <div className="space-y-2" aria-label={t(($) => $.quota_sources.dialog.loading)}>
                    {Array.from({ length: 3 }).map((_, index) => (
                      <Skeleton key={index} className="h-24 w-full" />
                    ))}
                  </div>
                ) : sourcesQuery.isError ? (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-body text-muted-foreground">
                      {t(($) => $.quota_sources.dialog.load_failed)}
                    </p>
                    <Button variant="outline" onClick={() => void sourcesQuery.refetch()}>
                      {t(($) => $.quota_sources.dialog.retry)}
                    </Button>
                  </div>
                ) : sources.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-body font-medium">
                      {t(($) => $.quota_sources.dialog.empty_title)}
                    </p>
                    <Button onClick={() => showForm(null)}>
                      <Plus aria-hidden="true" />
                      {t(($) => $.quota_sources.dialog.add)}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sources.map((source) => {
                      const updating = updateSource.isPending && updateSource.variables?.id === source.id;
                      const refreshing = refreshSource.isPending && refreshSource.variables === source.id;
                      const cooldown = quotaSourceRefreshCooldownSeconds(source, now);
                      const observedAt = source.quota?.observed_at ?? 0;
                      const interrupted = observedAt > 0 && isCollectorObservationInterrupted(observedAt, now);
                      const status = !source.enabled
                        ? t(($) => $.quota_sources.status.disabled)
                        : updating || refreshing
                          ? t(($) => $.quota_sources.status.probing)
                          : source.last_error
                            ? quotaSourceErrorLabel(source.last_error.code, t)
                            : interrupted
                              ? tQuota(($) => $.collection_interrupted)
                              : t(($) => $.quota_sources.status.ok);
                      return (
                        <article
                          key={source.id}
                          className={cn("rounded-lg border p-3", !source.enabled && "opacity-60")}
                        >
                          <div className="flex flex-wrap items-start gap-3">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <QuotaSourceIcon kind={source.kind} />
                              <span className="min-w-0">
                                <span className="flex min-w-0 flex-wrap items-center gap-2">
                                  <span className="truncate text-body font-medium">{source.name}</span>
                                  <Badge variant="secondary" className="font-normal">
                                    {quotaSourceKindLabel(source.kind, t)}
                                  </Badge>
                                  <Badge
                                    variant={source.last_error ? "destructive" : "secondary"}
                                    className="font-normal"
                                  >
                                    {(updating || refreshing) && (
                                      <Loader2 aria-hidden="true" className="animate-spin" />
                                    )}
                                    {status}
                                  </Badge>
                                </span>
                                <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground">
                                  <span className="font-mono">
                                    {source.credential_hint ? `•••• ${source.credential_hint}` : "••••••••"}
                                  </span>
                                  <span>{t(($) => $.quota_sources.visibility[source.visibility === "shared" ? "shared" : "private"])}</span>
                                  {observedAt > 0 && (
                                    <span className="tabular-nums">
                                      {tQuota(($) => $.observed_ago, {
                                        time: formatCompactDuration(now - observedAt * 1000),
                                      })}
                                    </span>
                                  )}
                                </span>
                              </span>
                            </div>

                            <div className="flex shrink-0 items-center gap-1">
                              <Switch
                                size="sm"
                                checked={source.enabled}
                                aria-label={t(($) => $.quota_sources.dialog.toggle, { name: source.name })}
                                disabled={listBusy}
                                onCheckedChange={async (enabled) => {
                                  setActionError(null);
                                  try {
                                    await updateSource.mutateAsync({ id: source.id, input: { enabled } });
                                  } catch (error) {
                                    setActionError(quotaSourceActionError(error, t));
                                  }
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t(($) => $.quota_sources.dialog.refresh, { name: source.name })}
                                title={cooldown > 0
                                  ? t(($) => $.quota_sources.dialog.refresh_in, { seconds: cooldown })
                                  : t(($) => $.quota_sources.dialog.refresh_now)}
                                disabled={listBusy || cooldown > 0 || !source.enabled}
                                onClick={async () => {
                                  setActionError(null);
                                  try {
                                    const refreshed = await refreshSource.mutateAsync(source.id);
                                    if (refreshed.last_error) {
                                      toast.error(quotaSourceErrorLabel(refreshed.last_error.code, t));
                                    } else {
                                      toast.success(t(($) => $.quota_sources.toasts.refreshed));
                                    }
                                  } catch (error) {
                                    setActionError(quotaSourceActionError(error, t));
                                  }
                                }}
                              >
                                <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t(($) => $.quota_sources.dialog.edit, { name: source.name })}
                                disabled={listBusy}
                                onClick={() => showForm(source)}
                              >
                                <Pencil aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-destructive"
                                aria-label={t(($) => $.quota_sources.dialog.delete, { name: source.name })}
                                disabled={listBusy}
                                onClick={() => {
                                  setActionError(null);
                                  setDeleting(source);
                                }}
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </div>
                          </div>
                          {cooldown > 0 && source.enabled && (
                            <p className="mt-2 text-right text-micro text-muted-foreground">
                              {t(($) => $.quota_sources.dialog.refresh_in, { seconds: cooldown })}
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>

              <DialogFooter className="shrink-0 items-center sm:justify-between">
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.quota_sources.dialog.auto_refresh)}
                </span>
                {!sourcesQuery.isPending && !sourcesQuery.isError && sources.length > 0 && (
                  <Button onClick={() => showForm(null)}>
                    <Plus aria-hidden="true" />
                    {t(($) => $.quota_sources.dialog.add)}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next && !deleteSource.isPending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.quota_sources.delete.title, { name: deleting?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.quota_sources.delete.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={deleteSource.isPending} onClick={() => setDeleting(null)}>
              {t(($) => $.quota_sources.delete.cancel)}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteSource.isPending || !deleting}
              aria-busy={deleteSource.isPending}
              onClick={async () => {
                if (!deleting) return;
                try {
                  await deleteSource.mutateAsync(deleting.id);
                  toast.success(t(($) => $.quota_sources.toasts.deleted));
                  setDeleting(null);
                } catch (error) {
                  setActionError(quotaSourceActionError(error, t));
                  setDeleting(null);
                }
              }}
            >
              {deleteSource.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {deleteSource.isPending
                ? t(($) => $.quota_sources.delete.deleting)
                : t(($) => $.quota_sources.delete.confirm)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
