"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { TriangleAlert } from "lucide-react";
import type { IssueAssigneeType, IssueStatus, UpdateIssueRequest } from "@multica/core/types";
import type { DependencyOverride, IssueDependencyPreview } from "@multica/core/api";
import { useUpdateIssue, useBatchUpdateIssues } from "@multica/core/issues/mutations";
import { dependencyErrorDetails, errorCode } from "@multica/core/api";
import { useActorName } from "@multica/core/workspace/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useShortcut, shortcutMatchesEvent, isPlainShortcut } from "@multica/core/shortcuts";
import { isImeComposing } from "@multica/core/utils";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";
import { useStatusLabel } from "../issues/utils/status-label";
import { blockedReasonLabel } from "../issues/blocked-trigger-copy";
import { useIssueTriggerPreview } from "../issues/hooks/use-issue-trigger-preview";
import { DependencyBlockedList } from "../issues/components/dependency-prerequisites";
import { useNavigation } from "../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { useT } from "../i18n";

// i18next inlines {{name}} / {{status}} into the sentence, but their position
// varies by language ("{{name}} 会…" vs "Once assigned, {{name}} will…" vs
// "{{name}}'s leader…"). Fence each one with a sentinel so we can bold just
// those spans at render time without splitting copy into per-language
// prefix/suffix keys. Bolding is also what marks a custom status name as a
// status rather than an ordinary word ("Move this issue to Later.").
const FENCE = "\u0000";

const fenced = (value: string) => `${FENCE}${value}${FENCE}`;

function boldFenced(text: string): ReactNode {
  const parts = text.split(FENCE);
  // Every fenced span contributes one odd-indexed part; an unfenced string is
  // a single part and renders as-is.
  if (parts.length < 3) return text;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-semibold text-foreground">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface RunConfirmData {
  issueIds?: string[];
  // The two issue writes that hand work to an agent, and the only two that
  // confirm. `assign` gives the issue an agent/squad owner; `promote` moves an
  // already-owned issue out of the backlog category, which starts the run on
  // its own (RunSourceStatus). Batch status changes still apply directly
  // (MUL-4155) — `promote` is the single-issue picker path only (MUL-6463).
  mode?: "assign" | "promote";
  /** promote only: the status KEY the issue is moving to. */
  status?: IssueStatus;
  assigneeType?: IssueAssigneeType;
  assigneeId?: string;
  assigneeName?: string;
  issueRevision?: number;
}

/** Localized per-item reason for a batch line the server refused. The
 *  dispatch vocabulary (queued/coalesced/deferred/blocked + reason_code) is
 *  the same one the comment trigger chips localize; unknown/empty codes fall
 *  back to the generic blocked label. */
function batchFailureReason(
  item: { reasonCode?: string; dispatch?: { reasonCode: string } | null },
  t: ReturnType<typeof useT<"issues">>["t"],
): string {
  return blockedReasonLabel(item.dispatch?.reasonCode ?? item.reasonCode ?? "", t);
}

/**
 * Handoff confirmation for the issue writes that start agent runs.
 *
 * The rule is "dialog = you are handing this to an agent", NOT "you are
 * confirming N runs" (MUL-5010). The buttons stay usable on the first frame —
 * nothing here waits on a network answer before it can be pressed.
 *
 * OL-44 adds the dependency layer on top of that: opening the dialog also
 * previews the exact prospective mutation (`POST /api/issues/preview-trigger`).
 * When a target has unfinished prerequisites the server reports the blocked
 * projection and — for an authenticated human only — a signed one-shot
 * confirmation. The dialog then replaces "confirm" with an explicit
 * "assign and start anyway" that echoes that confirmation as
 * `dependencyOverride` on the compound write. The override authorizes THIS
 * execution only; a changed mutation, a moved prerequisite set, or an expired
 * challenge all force a fresh preview and a fresh decision.
 *
 * Completion is silent: the assignee/status change and any run it starts
 * surface through the issue's normal updates, so the confirm adds no result
 * toast. Whether a run starts stays the server's existing decision at write
 * time. Dismissing the dialog (X / Esc / click-outside) cancels without any
 * write. Shared by single assign (1 id), batch assign (N ids), and the
 * single-issue promotion out of backlog.
 */
export function RunConfirmModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const { t } = useT("modals");
  const { t: tIssues } = useT("issues");
  const { getActorName } = useActorName();
  const sendShortcut = useShortcut("send");
  const d = (data ?? {}) as RunConfirmData;
  const issueIds = useMemo(() => d.issueIds ?? [], [d.issueIds]);

  // Which footer action is in flight, so only the clicked button shows a
  // spinner (the write is not instant — the disabled-only state read as frozen).
  const [pendingAction, setPendingAction] = useState<"go" | "suppress" | null>(null);
  const submitting = pendingAction !== null;

  const updateIssue = useUpdateIssue();
  const batchUpdate = useBatchUpdateIssues();

  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  // Built-ins resolve through i18n, custom statuses through the catalog, so the
  // promotion headline reads the same way the picker the user just used does.
  const statusLabel = useStatusLabel(wsId);

  // A promotion carries the status and nothing else: the owner is already on
  // the issue, and re-sending the same assignee would turn a status write into
  // an assignee write on the server's side of the trigger predicate.
  const isPromote = d.mode === "promote" && !!d.status;

  // The ONE prospective write body. The preview signs exactly this, and the
  // confirm extends the same object with suppress_run / dependencyOverride —
  // never a second, separately-assembled payload that could drift from what
  // was previewed (OL-44 review).
  const baseMutation = useMemo<UpdateIssueRequest>(
    () =>
      isPromote
        ? { status: d.status }
        : {
            assignee_type: d.assigneeType ?? null,
            assignee_id: d.assigneeId ?? null,
          },
    [isPromote, d.status, d.assigneeType, d.assigneeId],
  );

  const preview = useIssueTriggerPreview({
    issueIds,
    mutation: baseMutation,
    enabled: issueIds.length > 0,
  });

  const blockedItems: IssueDependencyPreview[] = useMemo(
    () => (preview.blocked ?? []).filter((b) => issueIds.includes(b.issueId)),
    [preview.blocked, issueIds],
  );
  const dependencyBlocked = blockedItems.length > 0;

  // --- confirmation freshness ------------------------------------------------
  // A placeholder answer belongs to a DIFFERENT (previous) mutation, and an
  // expired challenge can never be consumed — both must disable the override
  // and both resolve by refetching a fresh signed confirmation.
  const [dependencyNotice, setDependencyNotice] = useState<
    "stale" | "expired" | "not_allowed" | null
  >(null);
  const [challengeExpired, setChallengeExpired] = useState(false);

  const earliestExpiry = useMemo(() => {
    const stamps = blockedItems
      .map((b) => b.confirmation?.expiresAt)
      .filter((s): s is string => !!s)
      .map((s) => Date.parse(s))
      .filter((n) => Number.isFinite(n));
    return stamps.length > 0 ? Math.min(...stamps) : null;
  }, [blockedItems]);

  useEffect(() => {
    if (earliestExpiry === null) {
      setChallengeExpired(false);
      return;
    }
    const remaining = earliestExpiry - Date.now();
    if (remaining <= 0) {
      setChallengeExpired(true);
      return;
    }
    setChallengeExpired(false);
    const timer = setTimeout(() => setChallengeExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [earliestExpiry]);

  // An expired challenge is dead weight: refresh immediately so the human
  // re-decides against the current prerequisites with a valid confirmation.
  useEffect(() => {
    if (challengeExpired) {
      setDependencyNotice((n) => n ?? "expired");
      preview.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challengeExpired]);

  // Fresh preview data settles every freshness notice: the panel now shows
  // the current reasons and carries a usable challenge. Skips the mount pass
  // — otherwise it would cancel an already-expired challenge detected by the
  // effect above on the same first render.
  const firstDataAtRef = useRef(preview.dataUpdatedAt);
  useEffect(() => {
    if (preview.dataUpdatedAt === firstDataAtRef.current) return;
    setChallengeExpired(false);
    setDependencyNotice(null);
  }, [preview.dataUpdatedAt]);

  /** Confirmations keyed by target — each blocked item's own challenge, never
   *  one item's approval carried onto another (OL-41 batch rule). */
  const overrideByIssue = useMemo(() => {
    const map: Record<string, DependencyOverride> = {};
    for (const item of blockedItems) {
      if (item.confirmation) {
        map[item.issueId] = {
          requestId: item.confirmation.requestId,
          challenge: item.confirmation.challenge,
        };
      }
    }
    return map;
  }, [blockedItems]);

  const overrideUsable =
    dependencyBlocked &&
    !challengeExpired &&
    !preview.isPlaceholderData &&
    Object.keys(overrideByIssue).length > 0;

  /** Batch lines the server refused even after the (possibly overridden)
   *  write — the modal stays open on these so a partial batch is reported
   *  per item, never as a blanket success. */
  const [batchFailures, setBatchFailures] = useState<
    { issueId: string; reasonCode?: string; dispatch?: { reasonCode: string } | null }[] | null
  >(null);

  // The copy names whoever the issue is handed to; for a squad that is the
  // squad itself, since its leader deciding who works is an internal detail.
  const assigneeName =
    d.assigneeName ??
    getActorName(d.assigneeType === "squad" ? "squad" : "agent", d.assigneeId ?? "");

  const submit = async (action: "go" | "suppress" | "override") => {
    if (issueIds.length === 0 || submitting) return;
    if (action === "override" && !overrideUsable) return;
    setPendingAction(action === "suppress" ? "suppress" : "go");
    const payload: UpdateIssueRequest = {
      ...baseMutation,
      ...(action === "suppress" ? { suppress_run: true } : {}),
    };
    try {
      // Completion is silent, exactly as before: the assignee and any run show
      // up through the issue's normal assignee / run-status updates, so there is
      // no result toast to add here. Whether a run started is the server's
      // existing decision at write time, not something this dialog reports.
      if (issueIds.length === 1) {
        await updateIssue.mutateAsync({
          id: issueIds[0]!,
          ...payload,
          ...(action === "override"
            ? { dependencyOverride: overrideByIssue[issueIds[0]!] }
            : {}),
        });
      } else {
        const result = await batchUpdate.mutateAsync({
          ids: issueIds,
          updates: payload,
          ...(action === "override" ? { dependencyOverrides: overrideByIssue } : {}),
        });
        // Per-item honesty (OL-41): a batch commits item by item, and the
        // blocked/refused ones must be named, not folded into the success count.
        const failures = (result.results ?? []).filter(
          (r) => r.updated === false || r.dispatch?.status === "blocked",
        );
        if (failures.length > 0) {
          setBatchFailures(failures);
          setPendingAction(null);
          return;
        }
      }
      onClose();
    } catch (err) {
      const dep = dependencyErrorDetails(err);
      if (dep) {
        switch (dep.reasonCode) {
          case "dependency_override_stale":
          case "dependency_override_expired":
          case "dependency_version_conflict":
          case "dependency_unsatisfied":
            // The prerequisites or the challenge moved under this dialog:
            // refresh the preview (new reasons, new challenge) and let the
            // human decide again — never auto-retry an ambiguous write.
            setDependencyNotice("stale");
            preview.refetch();
            setPendingAction(null);
            return;
          case "dependency_override_not_allowed":
            setDependencyNotice("not_allowed");
            preview.refetch();
            setPendingAction(null);
            return;
        }
      }
      toast.error(
        errorCode(err) === "revision_conflict"
          ? tIssues(($) => $.revision.conflict)
          : err instanceof Error && err.message
            ? err.message
            : t(($) => $.run_confirm.toast_failed),
      );
      setPendingAction(null);
    }
  };

  /**
   * The configured `send` chord confirms the assignment, the same chord that
   * creates from the issue composer (MUL-5694).
   *
   * Bound on the dialog, not on a single control, because the chord means "run
   * the primary action" no matter which control has focus — and with only the
   * footer left to focus, that is precisely where the keycap on the confirm
   * button would otherwise be advertising a dead key.
   *
   * While a dependency block is on screen the chord is deliberately inert: an
   * early-dispatch release must be a deliberate click on the explicitly labeled
   * button, never a reflexive ⌘⏎ (OL-44). The buttons themselves keep their
   * native keyboard activation.
   */
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (dependencyBlocked) return;
    // A held chord submits once, and the Enter that commits an IME
    // composition is the user picking a candidate, never a confirmation.
    if (e.defaultPrevented || e.repeat || isImeComposing(e)) return;
    if (!shortcutMatchesEvent(sendShortcut, e.nativeEvent)) return;
    // Only a BARE Enter activates a focused button (Chromium fires no click
    // for ⌘/Ctrl+Enter), so a `send` remapped to plain Enter is the one case
    // where confirming here too would double-write — and on "Don't start yet"
    // the two writes would disagree about suppress_run. Every chord form
    // reaches the footer as a dead key without us, so it must not be skipped.
    const activatesFocusedButton =
      isPlainShortcut(sendShortcut, "Enter") &&
      e.target instanceof HTMLElement &&
      e.target.closest("button") !== null;
    if (activatesFocusedButton) return;
    e.preventDefault();
    void submit(false as unknown as "go");
  };

  // States the action, not a prediction: the write is certain, the run is
  // conditional, so the copy names no run count. The promotion names the
  // status it is moving to by its workspace label — a custom status is only
  // recognisable by the name its admin gave it.
  const headline: ReactNode = boldFenced(
    isPromote
      ? t(($) => $.run_confirm.promote_single, {
          name: fenced(assigneeName),
          status: fenced(statusLabel(d.status ?? "")),
        })
      : issueIds.length > 1
        ? t(($) => $.run_confirm.assign_batch, {
            name: fenced(assigneeName),
            count: issueIds.length,
          })
        : t(($) => $.run_confirm.assign_single, { name: fenced(assigneeName) }),
  );

  const openBlockedIssue = (issueId: string) => {
    // Inspecting a blocker leaves the confirmation un-consumed: cancel the
    // dialog (no write) and navigate to the prerequisite.
    navigation.push(paths.issueDetail(issueId));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <DialogContent onKeyDown={onDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {batchFailures
              ? t(($) => $.run_confirm.title_partial)
              : isPromote
                ? t(($) => $.run_confirm.title_promote)
                : t(($) => $.run_confirm.title_assign)}
          </DialogTitle>
          <DialogDescription>{headline}</DialogDescription>
        </DialogHeader>

        {batchFailures ? (
          <div className="flex flex-col gap-1.5">
            {batchFailures.map((f) => (
              <div
                key={f.issueId}
                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-caption"
              >
                <span className="tabular-nums text-muted-foreground">{f.issueId}</span>
                <span className="text-right">{batchFailureReason(f, tIssues)}</span>
              </div>
            ))}
          </div>
        ) : (
          dependencyBlocked && (
            <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="flex items-center gap-1.5 text-caption font-medium text-warning">
                <TriangleAlert className="size-3.5 shrink-0" />
                {t(($) => $.run_confirm.blocked_title)}
              </div>
              <DependencyBlockedList
                wsId={wsId}
                items={blockedItems}
                showTarget={issueIds.length > 1}
                onOpenIssue={openBlockedIssue}
              />
              <p className="text-micro text-muted-foreground">
                {t(($) => $.run_confirm.blocked_one_time_note)}
              </p>
              {dependencyNotice === "stale" && (
                <p className="text-micro text-warning">
                  {t(($) => $.run_confirm.stale_notice)}
                </p>
              )}
              {dependencyNotice === "expired" && (
                <p className="text-micro text-warning">
                  {t(($) => $.run_confirm.expired_notice)}
                </p>
              )}
              {dependencyNotice === "not_allowed" && (
                <p className="text-micro text-warning">
                  {t(($) => $.run_confirm.override_unavailable)}
                </p>
              )}
              {blockedItems.every((b) => !b.confirmation) && !dependencyNotice && (
                <p className="text-micro text-muted-foreground">
                  {t(($) => $.run_confirm.override_unavailable)}
                </p>
              )}
            </div>
          )
        )}

        {/* The only spinner is on the button the user just pressed, and it
            reflects the write in flight — never a pre-flight check. */}
        <DialogFooter>
          {batchFailures ? (
            <Button type="button" onClick={onClose}>
              {t(($) => $.run_confirm.close)}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => void submit("suppress")}>
                {pendingAction === "suppress" ? <Spinner className="size-4" /> : t(($) => $.run_confirm.dont_start)}
              </Button>
              {dependencyBlocked ? (
                <Button
                  type="button"
                  disabled={submitting || !overrideUsable}
                  onClick={() => void submit("override")}
                >
                  {pendingAction === "go" ? (
                    <Spinner className="size-4" />
                  ) : isPromote
                    ? t(($) => $.run_confirm.override_promote)
                    : t(($) => $.run_confirm.override_assign)}
                </Button>
              ) : (
                <Button type="button" disabled={submitting} onClick={() => void submit("go")}>
                  {pendingAction === "go" ? (
                    <Spinner className="size-4" />
                  ) : (
                    <>
                      {isPromote
                        ? t(($) => $.run_confirm.confirm_promote)
                        : t(($) => $.run_confirm.confirm_assign)}
                      {/* Decorative: the accessible name stays the button's own copy,
                          not "Confirm assignment Command Enter". Absent when `send`
                          is unbound. */}
                      {sendShortcut ? (
                        <ShortcutKeycaps
                          shortcut={sendShortcut}
                          decorative
                          className="ml-1"
                          keyClassName="border-background/30 bg-background/15 text-primary-foreground shadow-none"
                        />
                      ) : null}
                    </>
                  )}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
