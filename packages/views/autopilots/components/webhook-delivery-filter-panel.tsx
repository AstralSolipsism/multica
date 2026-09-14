"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Filter,
  HelpCircle,
  Loader2,
} from "lucide-react";
import {
  autopilotDeliveryFilterPreviewOptions,
  serializeWebhookEventFilters,
  useUpdateAutopilotTrigger,
} from "@multica/core/autopilots";
import { useWorkspaceId } from "@multica/core/hooks";
import { ApiError } from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import type {
  AutopilotTrigger,
  WebhookDelivery,
  WebhookEventFilter,
} from "@multica/core/types";
import { useT } from "../../i18n";
import { WebhookEventFilterSection } from "./webhook-event-filter-section";

// ---------------------------------------------------------------------------
// DeliveryFilterPanel — derive a webhook event filter from one stored
// delivery and preview the match verdict before saving (OL-78).
//
// The server owns every rule here: `filter_context.suggestion` is derived
// from the stored payload, and the verdict comes from re-fetching the detail
// with `?event_filters=<draft>` so the preview runs the same matcher that
// gates real dispatch. The panel never splits events or guesses candidates
// locally, and it never replays the delivery or starts a run.
// ---------------------------------------------------------------------------

interface DeliveryFilterPanelProps {
  autopilotId: string;
  deliveryId: string;
  /** Loaded detail row (undefined while loading or on error). */
  detail: WebhookDelivery | undefined;
  detailLoading: boolean;
  detailError: unknown;
  /** The delivery's webhook trigger; undefined when it can't be resolved. */
  trigger: AutopilotTrigger | undefined;
  canWrite: boolean;
  /** Reports unsaved-draft state so the host dialog can guard its close. */
  onDirtyChange: (dirty: boolean) => void;
}

// The bring-in merge. A same-event row with empty actions already accepts
// every action, and an identical row is already covered — in both cases the
// suggestion is present in effect, so we don't append a redundant row.
function mergeSuggestion(
  saved: WebhookEventFilter[],
  suggestion: WebhookEventFilter,
): WebhookEventFilter[] {
  const actions = suggestion.actions ?? [];
  const covered = saved.some((f) => {
    if (f.event !== suggestion.event) return false;
    const existing = f.actions ?? [];
    if (existing.length === 0) return true;
    if (existing.length !== actions.length) return false;
    const a = [...existing].sort();
    const b = [...actions].sort();
    return a.every((v, i) => v === b[i]);
  });
  if (covered) return [...saved];
  const row: WebhookEventFilter = { event: suggestion.event };
  if (actions.length > 0) row.actions = [...actions];
  return [...saved, row];
}

export function DeliveryFilterPanel({
  autopilotId,
  deliveryId,
  detail,
  detailLoading,
  detailError,
  trigger,
  canWrite,
  onDirtyChange,
}: DeliveryFilterPanelProps) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const updateTrigger = useUpdateAutopilotTrigger();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WebhookEventFilter[]>([]);
  // Baseline snapshot taken when edit mode opens; dirty compares against it,
  // NOT against the live trigger prop, so a mid-edit refetch of the autopilot
  // detail never silently re-baselines (or wipes) the user's unsaved edits.
  const baselineRef = useRef("");

  const savedFilters = useMemo<WebhookEventFilter[]>(
    () => trigger?.event_filters ?? [],
    [trigger],
  );

  const filterContext = detail?.filter_context;
  const suggestion = filterContext?.suggestion ?? null;
  const unavailableReason = filterContext?.unavailable_reason;
  // With a missing/unparseable stored body the contract guarantees
  // matches:null for every draft — don't spend a fetch confirming it.
  const bodyNormalizable =
    filterContext != null &&
    unavailableReason !== "raw_body_missing" &&
    unavailableReason !== "raw_body_invalid";

  // The preview always evaluates the CURRENT filter state: the saved filters
  // in read mode, the in-progress draft while editing. Keyed by the exact
  // draft sent, so a superseded request can only fill its own cache entry.
  const previewFilters = editing ? draft : savedFilters;
  const previewQuery = useQuery(
    autopilotDeliveryFilterPreviewOptions(
      wsId,
      autopilotId,
      deliveryId,
      previewFilters,
      { enabled: bodyNormalizable },
    ),
  );

  const dirty =
    editing && serializeWebhookEventFilters(draft) !== baselineRef.current;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const bringIn = () => {
    if (!suggestion) return;
    baselineRef.current = serializeWebhookEventFilters(savedFilters);
    setDraft(mergeSuggestion(savedFilters, suggestion));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft([]);
  };

  const save = async () => {
    if (!trigger) return;
    try {
      await updateTrigger.mutateAsync({
        autopilotId,
        triggerId: trigger.id,
        // An empty draft is sent as [] — the explicit "clear all filters"
        // tri-state value, not "leave unchanged".
        event_filters: draft,
      });
      toast.success(t(($) => $.deliveries.filter.toast_saved));
      setEditing(false);
      setDraft([]);
    } catch (e) {
      // Keep the draft and stay in edit mode: a failed save must not lose
      // the conditions the user just assembled.
      toast.error(
        e instanceof Error && e.message
          ? e.message
          : t(($) => $.deliveries.filter.toast_save_failed),
      );
    }
  };

  // --- Detail fetch states -------------------------------------------------

  if (detailError) {
    const status = detailError instanceof ApiError ? detailError.status : 0;
    return (
      <PanelShell>
        <p className="text-caption text-muted-foreground">
          {status === 404
            ? t(($) => $.deliveries.filter.delivery_unavailable)
            : t(($) => $.deliveries.filter.load_failed)}
        </p>
      </PanelShell>
    );
  }

  if (detailLoading && !detail) {
    return (
      <PanelShell>
        <Skeleton className="h-14 w-full" />
      </PanelShell>
    );
  }

  // filter_context is additive (OL-77): absent on older servers and coerced
  // to null by the schema when malformed — both read as "unavailable", never
  // as a guessed suggestion.
  if (!detail || filterContext == null) {
    if (!detail) return null;
    return (
      <PanelShell>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.deliveries.filter.unsupported_server)}
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      {/* Suggestion card (read mode only — in edit mode the suggestion is
          already one of the draft rows). */}
      {!editing && suggestion && (
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-micro text-muted-foreground">
            {t(($) => $.deliveries.filter.suggestion_label)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption">
            <span className="font-mono font-medium text-foreground">
              {suggestion.event}
            </span>
            <span className="text-muted-foreground">:</span>
            {suggestion.actions && suggestion.actions.length > 0 ? (
              suggestion.actions.map((action) => (
                <code
                  key={action}
                  className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-micro"
                >
                  {action}
                </code>
              ))
            ) : (
              <span className="text-muted-foreground">
                {t(($) => $.deliveries.filter.any_action)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Why no suggestion exists + the format help that stands in for an
          event catalog (the server does not enumerate provider events). */}
      {!editing && !suggestion && (
        <div className="space-y-1.5">
          <p className="text-caption text-muted-foreground">
            {unavailableReason === "raw_body_missing"
              ? t(($) => $.deliveries.filter.reason_raw_body_missing)
              : unavailableReason === "raw_body_invalid"
                ? t(($) => $.deliveries.filter.reason_raw_body_invalid)
                : unavailableReason === "event_empty"
                  ? t(($) => $.deliveries.filter.reason_event_empty)
                  : t(($) => $.deliveries.filter.reason_unknown)}
          </p>
          <p className="text-micro text-muted-foreground leading-relaxed">
            {t(($) => $.deliveries.filter.format_help)}
          </p>
        </div>
      )}

      {/* Editor (edit mode): the shared multi-row editor keeps manual input,
          same-event OR rows and empty-action semantics unchanged. */}
      {editing && (
        <WebhookEventFilterSection
          filters={draft}
          onChange={setDraft}
          hideLabel
        />
      )}

      {/* Live verdict for the current filters / draft. aria-live announces
          the flip after a bring-in or an edit without a focus change. */}
      <div aria-live="polite">
        {bodyNormalizable ? (
          <LiveVerdict
            loading={previewQuery.isLoading}
            error={previewQuery.isError}
            matches={previewQuery.data?.filter_context?.matches}
          />
        ) : (
          <VerdictRow icon="unknown" />
        )}
      </div>

      {/* Actions */}
      {editing ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={cancelEdit}
            disabled={updateTrigger.isPending}
          >
            {t(($) => $.deliveries.filter.cancel)}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={updateTrigger.isPending || !trigger}
            aria-busy={updateTrigger.isPending || undefined}
          >
            {updateTrigger.isPending
              ? t(($) => $.deliveries.filter.saving)
              : t(($) => $.deliveries.filter.save)}
          </Button>
        </div>
      ) : (
        suggestion != null &&
        (canWrite ? (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={bringIn}
              disabled={!trigger}
            >
              <Filter className="h-3.5 w-3.5 mr-1" />
              {t(($) => $.deliveries.filter.bring_in)}
            </Button>
          </div>
        ) : (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.deliveries.filter.read_only_hint)}
          </p>
        ))
      )}

      <p className="text-micro text-muted-foreground leading-relaxed">
        {t(($) => $.deliveries.filter.scope_note)}
      </p>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  const { t } = useT("autopilots");
  return (
    <div className="space-y-2.5 rounded-md border border-dashed px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-micro font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        <Filter className="size-3" />
        {t(($) => $.deliveries.filter.section_title)}
      </div>
      {children}
    </div>
  );
}

// --- Verdict ---------------------------------------------------------------

type VerdictKind = "yes" | "no" | "unknown";

function LiveVerdict({
  loading,
  error,
  matches,
}: {
  loading: boolean;
  error: boolean;
  matches: boolean | null | undefined;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <VerdictLabel />
        <LoadingText />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-caption text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />
        <VerdictLabel />
        <ErrorText />
      </div>
    );
  }
  return (
    <VerdictRow
      icon={matches === true ? "yes" : matches === false ? "no" : "unknown"}
    />
  );
}

function VerdictRow({ icon }: { icon: VerdictKind }) {
  const { t } = useT("autopilots");
  const visual =
    icon === "yes"
      ? {
          className: "text-emerald-500",
          Icon: CheckCircle2,
          text: t(($) => $.deliveries.filter.match_yes),
        }
      : icon === "no"
        ? {
            className: "text-amber-600 dark:text-amber-400",
            Icon: Ban,
            text: t(($) => $.deliveries.filter.match_no),
          }
        : {
            className: "text-muted-foreground",
            Icon: HelpCircle,
            text: t(($) => $.deliveries.filter.match_unknown),
          };
  return (
    <div
      className={cn("flex items-center gap-1.5 text-caption", visual.className)}
    >
      <visual.Icon className="h-3.5 w-3.5" />
      <VerdictLabel />
      <span>{visual.text}</span>
    </div>
  );
}

function VerdictLabel() {
  const { t } = useT("autopilots");
  return (
    <span className="text-muted-foreground">
      {t(($) => $.deliveries.filter.preview_label)}:
    </span>
  );
}

function LoadingText() {
  const { t } = useT("autopilots");
  return <span>{t(($) => $.deliveries.filter.match_loading)}</span>;
}

function ErrorText() {
  const { t } = useT("autopilots");
  return <span>{t(($) => $.deliveries.filter.match_error)}</span>;
}
