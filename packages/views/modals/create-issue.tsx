"use client";

import { issueStatusCategory } from "@multica/core/issues";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { AppLink, resolveClickIntent, useNavigation } from "../navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUser,
  FolderKanban,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Settings2,
  Shapes,
  Tag,
  Workflow,
  X as XIcon,
} from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import type {
  CreateIssueRequest,
  Issue,
  IssueStatus,
  IssuePriority,
  IssueAssigneeType,
  IssuePropertyValue,
  SourceContextPreview,
} from "@multica/core/types";
import { contentReferencesAttachment } from "@multica/core/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@multica/ui/components/ui/tooltip";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Switch } from "@multica/ui/components/ui/switch";
import { ContentEditor, type ContentEditorRef, TitleEditor, type TitleEditorRef, useFileDropZone, FileDropOverlay, useUploadGate, useComposerSubmit } from "../editor";
import { useIssueCreateUploads } from "./use-issue-create-uploads";
import { useShortcut } from "@multica/core/shortcuts";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";
import { StatusIcon, StatusPicker, PriorityIcon, PriorityPicker, StagePicker, AssigneePicker, StartDatePicker, DueDatePicker, LabelPicker } from "../issues/components";
import { maxSiblingStage } from "../issues/components/pickers/stage-picker";
import { ProjectPicker } from "../projects/components/project-picker";
import { useIssueTriggerPreview } from "../issues/hooks/use-issue-trigger-preview";
import { useActorName } from "@multica/core/workspace/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useIssueDraftStore, type IssueCreateDraft, type PendingDependencyCreate } from "@multica/core/issues/stores/draft-store";
import { useCreateModeStore } from "@multica/core/issues/stores/create-mode-store";
import { useQuickCreateStore } from "@multica/core/issues/stores/quick-create-store";
import {
  useIssueCreateSettingsStore,
  type ManualCreateField,
} from "@multica/core/issues/stores/issue-create-settings-store";
import { issueDetailOptions, childIssuesOptions } from "@multica/core/issues/queries";
import {
  useCreateCommentSubIssue,
  useCreateIssue,
  useIssueTriggerPreviewCheck,
  useUpdateIssue,
} from "@multica/core/issues/mutations";
import { useAttachLabelToIssue } from "@multica/core/labels";
import {
  propertyListOptions,
  useSetIssueProperty,
} from "@multica/core/properties";
import {
  ApiError,
  canonicalDependencyMutation,
  dependencyErrorDetails,
  DuplicateIssueErrorBodySchema,
  type DependencyMutationFields,
  type DuplicateIssueErrorBody,
  parseWithFallback,
} from "@multica/core/api";
import { FileUploadButton } from "@multica/ui/components/common/file-upload-button";
import { ClearablePillButton, PillButton } from "../common/pill-button";
import { ActorAvatar } from "../common/actor-avatar";
import { PropertyIcon } from "../common/property-icon";
import {
  CustomPropertyValueDisplay,
  CustomPropertyValueInput,
} from "../issues/components/pickers/custom-property-picker";
import { IssuePickerModal } from "./issue-picker-modal";
import { DependencyBlockedList } from "../issues/components/dependency-prerequisites";
import { useT } from "../i18n";
import { SourceContextPreviewCard, useSourceContextFailureMessage } from "./source-context-preview";
import { useIssueLimitUpgradePrompt } from "./use-issue-limit-upgrade-prompt";

/** Whether a held one-shot confirmation can still be consumed (5-minute
 *  server TTL). A malformed expiry reads as dead, never replayed. */
function permitExpired(pending: PendingDependencyCreate): boolean {
  const at = Date.parse(pending.item.confirmation?.expiresAt ?? "");
  return !Number.isFinite(at) || at <= Date.now();
}

/** Whether the held permit may still be replayed for this user. Expiry only
 *  retires UNUSED permits: the server looks up the request record first and
 *  checks expiry only when nothing was ever committed (dependency_override.go),
 *  so a permit whose confirmed write may have committed (uncertain outcome)
 *  replays at any age — the server, not the local clock, adjudicates the
 *  original result. Discarding it locally is exactly the double-create risk
 *  the mechanism exists to prevent (OL-44 third review P1). */
function permitRestorable(pending: PendingDependencyCreate): boolean {
  return pending.uncertain === true || !permitExpired(pending);
}

/** Digest-level equality between the operation a permit signed and the one
 *  on screen — key order and blocked_by ordering are presentation details,
 *  not a different operation (same rule as the server's payload digest). */
function sameDependencyMutation(
  a: CreateIssueRequest & DependencyMutationFields,
  b: CreateIssueRequest & DependencyMutationFields,
): boolean {
  return (
    JSON.stringify(canonicalDependencyMutation(a)) ===
    JSON.stringify(canonicalDependencyMutation(b))
  );
}

// ---------------------------------------------------------------------------
// ManualCreatePanel — manual-mode body of the create-issue dialog. Renders
// DialogContent + everything inside; the surrounding `<Dialog>` is owned by
// CreateIssueDialog so mode switching swaps only the inner panel without
// remounting the Dialog Root (no overlay flash). `onSwitchMode` flips the
// shell's local mode state.
// ---------------------------------------------------------------------------

// CreateRunHint is the create modal's passive pre-trigger label (MUL-3375 §4):
// whether saving will start a run, driven by the unified backend predicate
// (preview, isCreate) — never a frontend guess. No dialog, no blocking.
//
// OL-44: when the form carries prerequisites (or a parent whose inherited
// prerequisites apply), the preview includes a diagnostics-only mutation so
// the hint can say "won't start — prerequisites unfinished" instead of
// falsely promising a start. This preview is NEVER the license: its challenge
// is signed over a partial body and is ignored; the submit path re-previews
// the exact create body for the authoritative confirmation.
//
// Visually it borrows the comment header's avatar+text line, minus the
// interactivity — purely a caption, never a link/hover-card. It renders its own
// reveal band (a grid 0fr→1fr collapse) so it sits on a dedicated row above the
// property toolbar without reflowing anything: collapsed it is 0px (the flex-1
// editor absorbs the delta), and it expands only once the predicate resolves,
// animating straight to the correct copy.
function CreateRunHint({
  assigneeType,
  assigneeId,
  status,
  parentIssueId,
  blockedBy,
}: {
  assigneeType?: IssueAssigneeType;
  assigneeId?: string;
  status: IssueStatus;
  parentIssueId?: string;
  blockedBy?: string[];
}) {
  const { t } = useT("modals");
  const { getActorName } = useActorName();
  const isAgentLike = assigneeType === "agent" || assigneeType === "squad";
  const hasRelations = (blockedBy?.length ?? 0) > 0 || !!parentIssueId;
  const preview = useIssueTriggerPreview({
    isCreate: true,
    assigneeType: assigneeType ?? null,
    assigneeId: assigneeId ?? null,
    status,
    mutation:
      isAgentLike && assigneeId && hasRelations
        ? {
            assignee_type: assigneeType,
            assignee_id: assigneeId,
            status,
            parent_issue_id: parentIssueId,
            blockedBy: [...(blockedBy ?? [])].sort(),
          }
        : undefined,
    enabled: isAgentLike && !!assigneeId,
  });

  // Reveal only after the predicate resolves so the band animates to the final
  // copy instead of flashing "parked" before the run preview lands.
  const ready = isAgentLike && !!assigneeId && !preview.isLoading;
  // A placeholder answer still describes the PREVIOUS field set — never show
  // its blocked verdict against the current one.
  const blocked =
    !preview.isPlaceholderData && (preview.blocked?.length ?? 0) > 0;
  const willStart = !blocked && preview.totalCount > 0;
  const isSquad = assigneeType === "squad";
  const triggerAgentId = preview.triggers[0]?.agent_id ?? assigneeId;

  // Avatar + copy mirror the flow. A squad doesn't "work" — its leader
  // evaluates and delegates — so the squad path keeps the squad as the subject
  // (avatar + name) and uses the leader-delegates copy. A single agent picks
  // the issue up directly; a parked issue shows whoever it was assigned to.
  let avatarType: string;
  let avatarId: string | undefined;
  let text: string;
  if (blocked) {
    avatarType = assigneeType ?? "agent";
    avatarId = assigneeId;
    text = t(($) => $.run_confirm.create_blocked);
  } else if (!willStart) {
    avatarType = assigneeType ?? "agent";
    avatarId = assigneeId;
    text = t(($) => $.run_confirm.create_parked);
  } else if (isSquad) {
    avatarType = "squad";
    avatarId = assigneeId;
    text = t(($) => $.run_confirm.create_will_start_squad, {
      name: getActorName("squad", assigneeId ?? ""),
    });
  } else {
    avatarType = "agent";
    avatarId = triggerAgentId;
    text = t(($) => $.run_confirm.create_will_start, {
      name: getActorName("agent", triggerAgentId ?? assigneeId ?? ""),
    });
  }

  return (
    <div
      className={cn(
        "grid shrink-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        ready ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      aria-hidden={!ready}
    >
      <div className="overflow-hidden">
        <div
          aria-live="polite"
          className={cn(
            "flex items-center gap-1.5 px-4 pb-1 pt-0.5 text-micro",
            blocked ? "text-warning" : "text-muted-foreground",
          )}
        >
          {avatarId && (
            <ActorAvatar
              actorType={avatarType}
              actorId={avatarId}
              size="sm"
              profileLink={false}
            />
          )}
          <span className="truncate">{text}</span>
        </div>
      </div>
    </div>
  );
}

export function ManualCreatePanel({
  onClose,
  onSwitchMode,
  data,
  isExpanded,
  setIsExpanded,
}: {
  onClose: () => void;
  /** Called with the carry payload to seed the agent panel after switch. */
  onSwitchMode?: (carry?: Record<string, unknown> | null) => void;
  data?: Record<string, unknown> | null;
  /** Lifted to the shell so DialogContent's mode-aware className can react
   *  without the body itself having to live inside DialogContent (which would
   *  re-mount the Portal on mode swap and replay the open animation). */
  isExpanded: boolean;
  setIsExpanded: (v: boolean) => void;
}) {
  const { t } = useT("modals");
  const { t: tIssues } = useT("issues");
  const { t: tEditor } = useT("editor");
  const { t: tProjects } = useT("projects");
  const router = useNavigation();
  const p = useWorkspacePaths();
  const workspaceName = useCurrentWorkspace()?.name;
  const anchorCommentId = typeof data?.anchor_comment_id === "string" ? data.anchor_comment_id : null;
  const sourcePreview = data?.source_context_preview as SourceContextPreview | undefined;
  const sourceContextLoading = data?.source_context_loading === true;
  const sourceContextFailed = data?.source_context_failed === true;
  const sourceContextError = data?.source_context_error;
  const refetchSourceContext = data?.source_context_refetch as (() => Promise<unknown>) | undefined;
  const sourceContextExpanded = typeof data?.source_context_expanded === "boolean"
    ? data.source_context_expanded
    : undefined;
  const onSourceContextExpandedChange = data?.source_context_on_expanded_change as ((expanded: boolean) => void) | undefined;
  const sourceContextFailureMessage = useSourceContextFailureMessage();
  const showIssueLimitUpgradePrompt = useIssueLimitUpgradePrompt();

  const draft = useIssueDraftStore((s) => s.draft);
  const setManual = useIssueDraftStore((s) => s.setManual);
  const setShared = useIssueDraftStore((s) => s.setShared);
  const setAgent = useIssueDraftStore((s) => s.setAgent);
  const setActiveMode = useIssueDraftStore((s) => s.setActiveMode);
  const clearDraft = useIssueDraftStore((s) => s.clearDraft);
  const setLastAssignee = useIssueDraftStore((s) => s.setLastAssignee);
  const setLastMode = useCreateModeStore((s) => s.setLastMode);
  const keepOpen = useQuickCreateStore((s) => s.keepOpen);
  const setKeepOpen = useQuickCreateStore((s) => s.setKeepOpen);
  const manualFields = useIssueCreateSettingsStore((s) => s.manualCreateFields);

  const sendShortcut = useShortcut("send");
  const [title, setTitle] = useState(draft.manual.title);
  const [formResetKey, setFormResetKey] = useState(0);
  const titleEditorRef = useRef<TitleEditorRef>(null);
  const descEditorRef = useRef<ContentEditorRef>(null);
  const { isDragOver: descDragOver, dropZoneProps: descDropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => descEditorRef.current?.uploadFile(f)),
  });
  const [status, setStatus] = useState<IssueStatus>((data?.status as IssueStatus) || draft.manual.status);
  const [priority, setPriority] = useState<IssuePriority>(
    (data?.priority as IssuePriority | undefined) ?? draft.shared.priority,
  );
  const [assigneeType, setAssigneeType] = useState<IssueAssigneeType | undefined>(() => {
    if (data && "assignee_type" in data) {
      return (data.assignee_type as IssueAssigneeType | null) ?? undefined;
    }
    return draft.manual.assigneeType;
  });
  const [assigneeId, setAssigneeId] = useState<string | undefined>(() => {
    if (data && "assignee_id" in data) {
      return (data.assignee_id as string | null) ?? undefined;
    }
    return draft.manual.assigneeId;
  });
  const [startDate, setStartDate] = useState<string | null>(draft.manual.startDate);
  const [dueDate, setDueDate] = useState<string | null>(
    (data?.due_date as string | undefined) ?? draft.shared.dueDate,
  );
  const [labelIds, setLabelIds] = useState<string[]>(draft.manual.labelIds);
  const [propertyValues, setPropertyValues] = useState(draft.manual.propertyValues ?? {});
  const [customPropertyPickerId, setCustomPropertyPickerId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>(() => {
    if (data && "project_id" in data) {
      return (data.project_id as string | null) ?? undefined;
    }
    return draft.shared.projectId;
  });
  const [parentIssueId, setParentIssueId] = useState<string | undefined>(
    (data?.parent_issue_id as string) || undefined,
  );
  const parentIssueLocked = anchorCommentId !== null
    && typeof data?.parent_issue_id === "string"
    && data.parent_issue_id.length > 0;
  // Stage only applies to a sub-issue; kept local (not in the persisted draft)
  // since it's a per-creation choice tied to the chosen parent.
  const [stage, setStage] = useState<number | null>(
    typeof data?.stage === "number" ? (data.stage as number) : null,
  );
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  // Toolbar fields hidden via Settings → Preferences → Issue creation reuse the overflow reveal
  // pattern: the ⋯ menu item flips this open, which mounts the inline pill
  // (the popover's anchor) AND opens the picker. Closing without a value
  // unmounts the pill again; a field holding a non-default value always
  // renders regardless of the setting so nothing applied is ever invisible.
  const [fieldPickerOpen, setFieldPickerOpen] = useState<Exclude<
    ManualCreateField,
    "due_date" | "start_date"
  > | null>(null);
  // Start date is a low-frequency field — by default it lives in the
  // overflow ⋯ menu. Clicking the menu item flips this open, which both
  // mounts the inline pill (the popover's anchor) AND opens the calendar.
  // When the popover closes without a value set, the pill unmounts again.
  const [startDatePickerOpen, setStartDatePickerOpen] = useState(false);
  // Due date follows the same overflow pattern as start date: collapsed into
  // the ⋯ menu by default, mounted inline (as the popover anchor) only when it
  // has a value or the user just opened it from the menu.
  const [dueDatePickerOpen, setDueDatePickerOpen] = useState(false);
  // Children live as full Issue objects — the picker always returns the whole
  // object, and we never need to hydrate from an ID the way we do for parent.
  const [childIssues, setChildIssues] = useState<Issue[]>([]);
  const [childPickerOpen, setChildPickerOpen] = useState(false);
  // Prerequisites (blocked_by) queued for the compound create. Only the IDs
  // persist in the manual draft — closing and reopening the dialog restores
  // them exactly like the title (OL-44 review), while the chips' display
  // labels come from the detail cache/Query because server data belongs
  // there, not in a persisted snapshot (CLAUDE.md state rules).
  const [blockedByIds, setBlockedByIds] = useState<string[]>(
    () => draft.manual.blockedBy ?? [],
  );
  const updateBlockedBy = (ids: string[]) => {
    setBlockedByIds(ids);
    setManual({ blockedBy: ids });
  };
  const [blockedByPickerOpen, setBlockedByPickerOpen] = useState(false);
  // The submit-time dependency confirmation (OL-41): when the preview of the
  // exact create body reports unfinished prerequisites, the pending body +
  // server-signed confirmation live in the draft store (runtime-only) so
  // they survive "Back to editing", dialog close, and navigating out to
  // inspect a blocker — the undetermined operation must be restored, never
  // silently replaced by a fresh attempt (OL-44 re-review P1). `confirmOpen`
  // is only the dialog's visibility; the permit outlives it.
  const pendingDependencyCreate = useIssueDraftStore((s) => s.pendingDependencyCreate);
  const setPendingDependencyCreate = useIssueDraftStore((s) => s.setPendingDependencyCreate);
  const [confirmOpen, setConfirmOpen] = useState(() => {
    const pending = useIssueDraftStore.getState().pendingDependencyCreate;
    return !!pending && permitRestorable(pending);
  });
  const [overrideCreating, setOverrideCreating] = useState(false);
  const wsId = useWorkspaceId();
  // Chip labels for queued prerequisites — resolved live from the detail
  // cache (a reopened draft's picks are usually already warm); the raw id
  // stays as the honest fallback while a label is unknown.
  const blockedByDetails = useQueries({
    queries: blockedByIds.map((id) => issueDetailOptions(wsId, id)),
  });
  const blockedByLabelOf = (id: string, index: number): string =>
    blockedByDetails[index]?.data?.identifier ?? id;
  // Fetch parent issue details for the chip (status/identifier/title).
  // List cache usually has it already, so this resolves synchronously.
  const { categoryOf: draftStatusCategory } = useIssueStatuses(wsId);
  const { data: workspaceProperties = [] } = useQuery(propertyListOptions(wsId));
  const { data: parentIssue } = useQuery({
    ...issueDetailOptions(wsId, parentIssueId ?? ""),
    enabled: !!parentIssueId,
  });
  // Sibling stages under the chosen parent, so the Stage picker can offer the
  // already-used max stage (and one beyond) instead of flooring at Stage 1–3.
  const { data: parentChildren = [] } = useQuery({
    ...childIssuesOptions(wsId, parentIssueId ?? ""),
    enabled: !!parentIssueId,
  });

  // Set the persisted draft's active mode so a later reopen (and any reader of
  // the unified draft) knows which form the user is editing in.
  useEffect(() => {
    setActiveMode("manual");
  }, [setActiveMode]);

  // Prune completed uploads whose markdown reference was deleted in an
  // earlier editing session. Runs once on mount: at that point the persisted
  // manual description / agent prompt ARE the draft bodies (no editor edits
  // have happened yet), so dropping `uploaded` records referenced by neither
  // is safe. Placeholders (uploading / failed / interrupted) are always kept —
  // they have no body reference yet and the status chips are their only UI.
  // Don't prune on description updates — an onUpdate flush can race a
  // just-finished upload whose markdown link hasn't been inserted yet, and
  // pruning there would drop a live attachment.
  useEffect(() => {
    const { draft: current } = useIssueDraftStore.getState();
    const uploads = current.shared.attachments ?? [];
    const kept = uploads.filter(
      (u) =>
        u.status !== "uploaded" ||
        contentReferencesAttachment(current.manual.description, u.attachment) ||
        contentReferencesAttachment(current.agent.prompt, u.attachment),
    );
    if (kept.length !== uploads.length) setShared({ attachments: kept });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Gate every action that fixes this draft: Create and the switch to agent
  // mode (which assist-inits the agent prompt from the description and would
  // carry a stripped body across).
  const uploadGate = useUploadGate(descEditorRef);
  // Coordinator-owned uploads in the shared pool (MUL-5181, L2): a file picked
  // here survives dialog close, aborts on logout, and is dropped after a
  // reload. `gate` widens the editor gate with the pool's placeholders.
  const {
    attachments: draftAttachments,
    handleUpload,
    gate,
  } = useIssueCreateUploads("manual", uploadGate, descEditorRef);

  // Sync field changes to the draft store — manual-only fields to the manual
  // slot, project / priority / due date to the shared slot.
  const updateTitle = (v: string) => { setTitle(v); setManual({ title: v }); };
  const updateStatus = (v: IssueStatus) => { setStatus(v); setManual({ status: v }); };
  const updatePriority = (v: IssuePriority) => { setPriority(v); setShared({ priority: v }); };
  const updateAssignee = (type?: IssueAssigneeType, id?: string) => {
    setAssigneeType(type); setAssigneeId(id);
    setManual({ assigneeType: type, assigneeId: id });
  };
  const updateProject = (id?: string) => { setProjectId(id); setShared({ projectId: id }); };
  const updateStartDate = (v: string | null) => { setStartDate(v); setManual({ startDate: v }); };
  const updateDueDate = (v: string | null) => { setDueDate(v); setShared({ dueDate: v }); };
  const updateLabelIds = (ids: string[]) => { setLabelIds(ids); setManual({ labelIds: ids }); };
  const updatePropertyValue = (propertyId: string, value: IssuePropertyValue | undefined) => {
    const next = { ...propertyValues };
    if (value === undefined) delete next[propertyId];
    else next[propertyId] = value;
    setPropertyValues(next);
    setManual({ propertyValues: next });
  };

  // Inline pill reveal per toolbar field: kept by Settings → Preferences → Issue creation, holding a
  // non-default value (a hidden field with a value must stay visible — the
  // draft or a mode-switch carry may have set it), or just opened from the ⋯
  // overflow (the picker popover needs the inline pill as its anchor).
  const showField = {
    status: manualFields.includes("status") || status !== "todo" || fieldPickerOpen === "status",
    priority: manualFields.includes("priority") || priority !== "none" || fieldPickerOpen === "priority",
    assignee: manualFields.includes("assignee") || assigneeId != null || fieldPickerOpen === "assignee",
    labels: manualFields.includes("labels") || labelIds.length > 0 || fieldPickerOpen === "labels",
    project: manualFields.includes("project") || projectId != null || fieldPickerOpen === "project",
    due_date: manualFields.includes("due_date") || dueDate !== null || dueDatePickerOpen,
    start_date: manualFields.includes("start_date") || startDate !== null || startDatePickerOpen,
  };

  const createIssueMutation = useCreateIssue();
  // Submit-time authoritative previews (exact create body) go through the
  // shared mutation wrapper — TanStack owns every server interaction, no
  // bare api.* calls in the component (CLAUDE.md state rules).
  const previewCheck = useIssueTriggerPreviewCheck();
  const createCommentSubIssueMutation = useCreateCommentSubIssue();
  const updateIssueMutation = useUpdateIssue();
  const attachLabelMutation = useAttachLabelToIssue();
  const setIssuePropertyMutation = useSetIssueProperty();
  const resetForNextIssue = () => {
    setTitle("");
    setStatus("todo");
    setPriority("none");
    setStartDate(null);
    setDueDate(null);
    setLabelIds([]);
    setPropertyValues({});
    setCustomPropertyPickerId(null);
    setProjectId(undefined);
    setParentIssueId(undefined);
    setStage(null);
    setChildIssues([]);
    updateBlockedBy([]);
    // Keep the just-used assignee for the next issue in the batch; reset
    // everything else across the manual + shared slots.
    setManual({
      title: "",
      description: "",
      status: "todo",
      assigneeType,
      assigneeId,
      startDate: null,
      labelIds: [],
      blockedBy: [],
      propertyValues: {},
    });
    setShared({
      priority: "none",
      projectId: undefined,
      dueDate: null,
      attachments: [],
    });
    descEditorRef.current?.clearContent();
    setFormResetKey((key) => key + 1);
  };

  // Manual create runs through the shared await-then-render composer contract
  // (single-flight ref, submit-time upload re-check, lock+spin, await→boolean,
  // clear only on acceptance). Manual is gated on the TITLE rather than the
  // editor body — a title-only issue is valid — so `normalize` ignores the
  // description markdown and feeds the title through as the empty-guard/content;
  // the body is read separately inside onSubmit.
  // Stale-submit guard (MUL-5181 P0): the issue draft is a SINGLETON store
  // and the editors stay interactive during a request. Snapshot the draft's
  // object identity at submit; success clears ONLY an untouched draft —
  // whether the edit came mid-flight or from a reopened dialog.
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const submittedDraftRef = useRef<IssueCreateDraft | null>(null);

  // The exact body a manual create submits. Built once per attempt so the
  // submit-time dependency preview and the write can never diverge (OL-41:
  // the confirmation challenge is signed over this payload). `blockedBy`
  // present — even as the complete set the user queued — routes the write to
  // the compound with-dependencies endpoint; omitted means "no relations".
  const buildCreateRequest = (
    description: string | undefined,
    activeAttachmentIds: string[],
  ): CreateIssueRequest & DependencyMutationFields => ({
    title: title.trim(),
    description,
    status,
    priority,
    assignee_type: assigneeType,
    assignee_id: assigneeId,
    start_date: startDate || undefined,
    due_date: dueDate || undefined,
    attachment_ids: activeAttachmentIds.length > 0 ? activeAttachmentIds : undefined,
    // The server attaches these in the same transaction as the create and
    // echoes them back as `issue.labels`, so a stale selection fails the
    // create instead of leaving a committed-but-unlabeled issue. A legacy
    // backend that predates this ignores the field — handled by the
    // compatibility fallback below.
    label_ids: labelIds.length > 0 ? labelIds : undefined,
    parent_issue_id: parentIssueId,
    // Stage is only meaningful for a sub-issue (relative to its siblings).
    stage: parentIssueId && stage != null ? stage : undefined,
    project_id: projectId,
    ...(blockedByIds.length > 0
      ? { blockedBy: [...blockedByIds].sort() }
      : {}),
  });

  // Everything after the issue row exists: property/sub-issue/label fan-out
  // (each failure toasts individually, none rolls the create back) and the
  // success toast. Shared by the plain submit and the override-confirm path.
  const finalizeCreatedIssue = async (issue: Issue) => {
    // Custom-property values can only be addressed once the issue has an
    // id. Keep the modal in its submitting state until every value settles
    // so closing or "Create another" cannot race the fan-out.
    const propertyEntries = Object.entries(propertyValues);
    if (propertyEntries.length > 0) {
      const results = await Promise.allSettled(
        propertyEntries.map(([propertyId, value]) =>
          setIssuePropertyMutation.mutateAsync({
            issueId: issue.id,
            propertyId,
            value,
          }),
        ),
      );
      let failed = 0;
      for (const result of results) {
        if (result.status === "rejected") {
          failed += 1;
          console.error("[create-issue] custom property set failed", result.reason);
        }
      }
      if (failed > 0) {
        toast.error(
          t(($) => $.create_issue.toast_set_properties_failed, { count: failed }),
        );
      }
    }

    // Link queued children to the new parent. Deferred to after create
    // because the new issue's ID doesn't exist yet. Partial failures don't
    // roll back the new issue — it's already committed.
    if (childIssues.length > 0) {
      const results = await Promise.allSettled(
        childIssues.map((child) =>
          updateIssueMutation.mutateAsync({
            id: child.id,
            parent_issue_id: issue.id,
          }),
        ),
      );
      // Aggregate fan-out: N independent requests can fail for N different
      // reasons. The user-facing toast stays count-based (any single
      // err.message would mislead), but log each rejection so developers
      // still have signal in dev-tools / Sentry.
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[create-issue] sub-issue link failed", result.reason);
        }
      }
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        toast.error(
          failed === childIssues.length
            ? t(($) => $.create_issue.toast_link_subissues_all_failed)
            : t(($) => $.create_issue.toast_link_subissues_partial, {
                failed,
                total: childIssues.length,
              }),
        );
      }
    }

    // Backend-compatibility fallback for the rolling deploy window: the web
    // app auto-deploys on merge but the backend deploys manually, so a newer
    // web build can briefly talk to a backend that predates atomic label
    // creation. That backend silently ignores `label_ids` and returns an
    // issue with no `labels` field. Only then do we fall back to the legacy
    // per-label attach so the user's labels aren't silently dropped. When
    // `labels` is present (current backend) the atomic path already ran, so
    // we skip this — no double-write, no per-label fan-out.
    if (labelIds.length > 0 && issue.labels === undefined) {
      const results = await Promise.allSettled(
        labelIds.map((labelId) =>
          attachLabelMutation.mutateAsync({ issueId: issue.id, labelId }),
        ),
      );
      let labelsFailed = 0;
      for (const result of results) {
        if (result.status === "rejected") {
          labelsFailed += 1;
          console.error("[create-issue] label attach fallback failed", result.reason);
        }
      }
      if (labelsFailed > 0) {
        toast.error(t(($) => $.create_issue.toast_link_labels_failed));
      }
    }

    // The old post-create "agent paused in Backlog" blocking panel is gone —
    // a passive inline hint now warns before submit (MUL-3375). The draft
    // reset + close/keep-open happens in onAccepted once we report success.
    {
      toast.custom((toastId) => (
        <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-[360px]">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex items-center justify-center size-5 rounded-full bg-emerald-500/15 text-emerald-500">
              <Check className="size-3" />
            </div>
            <span className="text-body font-medium">{t(($) => $.create_issue.toast_created)}</span>
          </div>
          <div className="flex items-center gap-2 text-body text-muted-foreground ml-7">
            <StatusIcon
              status={issue.status}
              category={issueStatusCategory(issue) ?? undefined}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">{issue.identifier} – {issue.title}</span>
          </div>
          {/* Not an AppLink: sonner renders toast content under <Toaster />,
              which is mounted outside NavigationProvider, so useNavigation()
              would throw here. */}
          <button
            type="button"
            className="ml-7 mt-2 text-body text-primary hover:underline cursor-pointer"
            onClick={() => {
              router.push(p.issueDetail(issue.id));
              toast.dismiss(toastId);
            }}
          >
            {t(($) => $.create_issue.view_issue)}
          </button>
        </div>
      ), { duration: 5000 });
    }
  };

  // The composer's onAccepted body, shared with the override-confirm path:
  // consume the draft only when it is still the one that was submitted
  // (MUL-5181 P0), then close or reset per "create another".
  const acceptSubmittedDraft = () => {
    // These preferences derive from the SUBMITTED values, not the live
    // draft — an issue was created, so record them regardless of the guard.
    setLastAssignee(assigneeType, assigneeId);
    setLastMode("manual");
    // Success may only consume the draft it submitted (MUL-5181 P0): any
    // edit after the submit snapshot — typing while the request is in
    // flight, or a reopened dialog — survives, and the dialog then stays
    // open on the newer draft instead of closing/resetting over it. Flush
    // the editor's pending debounce first so mid-flight typing still inside
    // the debounce window is judged correctly.
    const lateDesc = descEditorRef.current?.flushPendingUpdate?.();
    if (lateDesc != null) setManual({ description: lateDesc });
    const untouched =
      useIssueDraftStore.getState().draft === submittedDraftRef.current;
    if (untouched) clearDraft();
    if (!mountedRef.current || !untouched) return;
    if (keepOpen) {
      resetForNextIssue();
    } else {
      onClose();
    }
  };

  // The dependency confirmation's explicit "create and start anyway": replay
  // the previewed body with its one-shot challenge. A stale/expired/!allowed
  // answer re-previews the same body for a fresh challenge and current
  // reasons — the human always re-decides; nothing auto-retries (OL-41).
  const submitDependencyOverride = async () => {
    const pending = pendingDependencyCreate;
    const confirmation = pending?.item.confirmation ?? null;
    if (!pending || !confirmation || overrideCreating) return;
    // The permit is digest-bound to the exact body it signed. Before
    // replaying it, prove the draft on screen still IS that operation — a
    // user who edited after an undetermined attempt must get a fresh
    // preview, not a replay against changed content.
    const currentDescription = descEditorRef.current?.getMarkdown()?.trim() || undefined;
    const currentAttachmentIds = draftAttachments
      .filter((a) => contentReferencesAttachment(currentDescription ?? "", a))
      .map((a) => a.id);
    if (!sameDependencyMutation(buildCreateRequest(currentDescription, currentAttachmentIds), pending.request)) {
      setPendingDependencyCreate(null);
      setConfirmOpen(false);
      toast.error(t(($) => $.create_issue.dependency_confirm.changed_note));
      return;
    }
    if (!permitRestorable(pending)) {
      setPendingDependencyCreate(null);
      setConfirmOpen(false);
      toast.error(t(($) => $.run_confirm.expired_notice));
      return;
    }
    // Snapshot the draft being submitted: the guard just proved the on-screen
    // draft IS this operation, and the modal dialog blocks edits mid-flight —
    // the same "consume only the submitted draft" guarantee the composer's
    // onSubmit snapshot gives the normal path (MUL-5181 P0). Without this,
    // a restored confirmation's success compares the draft against null and
    // wrongly keeps the window open (OL-44 third review P2).
    submittedDraftRef.current = useIssueDraftStore.getState().draft;
    setOverrideCreating(true);
    try {
      const issue = await createIssueMutation.mutateAsync({
        ...pending.request,
        dependencyOverride: {
          requestId: confirmation.requestId,
          challenge: confirmation.challenge,
        },
      });
      await finalizeCreatedIssue(issue);
      setPendingDependencyCreate(null);
      setConfirmOpen(false);
      acceptSubmittedDraft();
    } catch (err) {
      const dep = dependencyErrorDetails(err);
      if (
        dep &&
        (dep.reasonCode === "dependency_override_stale" ||
          dep.reasonCode === "dependency_override_expired" ||
          dep.reasonCode === "dependency_version_conflict" ||
          dep.reasonCode === "dependency_unsatisfied")
      ) {
        try {
          const refreshed = await previewCheck.mutateAsync({
            isCreate: true,
            mutation: pending.request,
          });
          const item = refreshed.blocked?.[0] ?? null;
          if (item) {
            setPendingDependencyCreate({ request: pending.request, item, refreshed: true });
          } else {
            // The prerequisites completed in the meantime — a plain create
            // now starts the run without any override.
            setPendingDependencyCreate(null);
            setConfirmOpen(false);
            toast.success(t(($) => $.create_issue.dependency_now_ready));
          }
        } catch {
          setPendingDependencyCreate(null);
          setConfirmOpen(false);
          toast.error(t(($) => $.create_issue.toast_failed));
        }
      } else if (!(err instanceof ApiError) || err.status >= 500) {
        // AMBIGUOUS failure (transport drop / 5xx): the server may have
        // committed before the answer was lost. Keep the exact request AND
        // its one-shot permit — replaying the same requestId returns the
        // original task (OL-41 idempotent replay), while discarding it and
        // re-previewing would issue a NEW permit that could create and run
        // twice (OL-44 review P1). The permit stays in the draft store even
        // if the dialog now closes. Only a definite refusal (dependency code
        // above, or any other 4xx below) clears it.
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.create_issue.toast_failed),
        );
        setPendingDependencyCreate({ ...pending, uncertain: true });
      } else {
        // Definite refusal (4xx, nothing committed) — including a credential
        // that may not override. Close back to the form with the reason.
        toast.error(
          dep?.reasonCode === "dependency_override_not_allowed"
            ? t(($) => $.create_issue.dependency_override_not_allowed)
            : err instanceof Error && err.message
              ? err.message
              : t(($) => $.create_issue.toast_failed),
        );
        setPendingDependencyCreate(null);
        setConfirmOpen(false);
      }
    } finally {
      setOverrideCreating(false);
    }
  };

  const composer = useComposerSubmit({
    editorRef: descEditorRef,
    uploadGate: gate,
    normalize: () => title.trim(),
    onSubmit: async (): Promise<boolean> => {
      // Flush the description editor's pending debounce into the store BEFORE
      // snapshotting, so a late flush of pre-submit typing cannot masquerade
      // as an edit made during the request.
      const pendingDesc = descEditorRef.current?.flushPendingUpdate?.();
      if (pendingDesc != null) setManual({ description: pendingDesc });
      submittedDraftRef.current = useIssueDraftStore.getState().draft;
      // The body actually attempted — the dependency refusal handling in
      // catch re-previews exactly it for the confirmation challenge.
      let attemptedRequest: (CreateIssueRequest & DependencyMutationFields) | undefined;
      try {
      const description = descEditorRef.current?.getMarkdown()?.trim() || undefined;
      const activeAttachmentIds = draftAttachments
        .filter((a) => contentReferencesAttachment(description ?? "", a))
        .map((a) => a.id);
      let issue: Issue;
      if (anchorCommentId && sourcePreview) {
        issue = await createCommentSubIssueMutation.mutateAsync({
          anchorCommentId,
          data: {
            mode: "manual",
            capture_token: sourcePreview.capture_token,
            issue: {
              title: title.trim(),
              description,
              status,
              priority,
              assignee_type: assigneeType,
              assignee_id: assigneeId,
              start_date: startDate || undefined,
              due_date: dueDate || undefined,
              attachment_ids: activeAttachmentIds.length > 0 ? activeAttachmentIds : undefined,
              label_ids: labelIds.length > 0 ? labelIds : undefined,
              stage: parentIssueId && stage != null ? stage : undefined,
              project_id: projectId,
            },
          },
        });
      } else {
        const request = buildCreateRequest(description, activeAttachmentIds);
        // OL-44: with an agent/squad assignee and prerequisites in play
        // (direct picks, or inherited ones through the parent), preview the
        // exact create body first. An unfinished-prerequisite verdict opens
        // the explicit one-shot confirmation instead of writing anything.
        // The preview is advisory: its failure never blocks the submit — the
        // compound write re-checks authoritatively and 409s below.
        const wantsRun =
          (assigneeType === "agent" || assigneeType === "squad") && !!assigneeId;
        if (wantsRun && (blockedByIds.length > 0 || parentIssueId)) {
          // A previous attempt with this exact body may still be
          // UNDETERMINED (transport failure): restore its confirmation
          // instead of minting a fresh permit — replaying the original
          // requestId is the only path that cannot double-create.
          const held = useIssueDraftStore.getState().pendingDependencyCreate;
          if (held && permitRestorable(held) && sameDependencyMutation(held.request, request)) {
            setConfirmOpen(true);
            return false;
          }
          if (held) {
            // Expired, or the operation itself changed — either way the old
            // permit is determined-dead and safe to replace.
            setPendingDependencyCreate(null);
          }
          try {
            const previewResult = await previewCheck.mutateAsync({
              isCreate: true,
              mutation: request,
            });
            const blockedItem = previewResult.blocked?.[0] ?? null;
            if (blockedItem && blockedItem.reasonCode === "dependency_unsatisfied") {
              setPendingDependencyCreate({ request, item: blockedItem });
              setConfirmOpen(true);
              return false;
            }
          } catch {
            // Preview unavailable (offline / older server): fall through to
            // the write — the server's answer is the authoritative one.
          }
        }
        attemptedRequest = request;
        issue = await createIssueMutation.mutateAsync(request);
        // A committed create determines any held pending operation: its
        // permit is spent, never replayable again.
        setPendingDependencyCreate(null);
      }

      await finalizeCreatedIssue(issue);
      return true;
    } catch (err) {
      const sourceCode = err instanceof ApiError && err.body && typeof err.body === "object"
        ? (err.body as { code?: unknown }).code
        : undefined;
      if (anchorCommentId && (
        sourceCode === "source_context_changed"
        || sourceCode === "anchor_comment_deleted"
        || sourceCode === "source_issue_deleted"
      )) {
        await refetchSourceContext?.();
        toast.error(sourceContextFailureMessage(err) ?? tIssues(($) => $.source_context.error_source_changed));
        return false;
      }
      if (anchorCommentId && sourceCode === "source_context_server_unsupported") {
        toast.error(tIssues(($) => $.source_context.error_server_unsupported));
        return false;
      }
      if (anchorCommentId && sourceCode === "source_context_too_large") {
        toast.error(sourceContextFailureMessage(err) ?? tIssues(($) => $.source_context.error_too_large));
        return false;
      }
      if (sourceCode === "issue_limit_reached") {
        showIssueLimitUpgradePrompt();
        return false;
      }
      // OL-44: dependency refusals from the compound write. The write is
      // atomic — nothing was committed, the form is still exactly what the
      // server rejected, and `attemptedRequest` is the body to re-preview.
      const depDetails = dependencyErrorDetails(err);
      if (depDetails && attemptedRequest) {
        if (depDetails.reasonCode === "dependency_unsatisfied") {
          // The advisory precheck raced a concurrent relation change: get
          // the signed confirmation now and open the explicit dialog.
          try {
            const previewResult = await previewCheck.mutateAsync({
              isCreate: true,
              mutation: attemptedRequest,
            });
            const item = previewResult.blocked?.[0] ?? null;
            if (item) {
              setPendingDependencyCreate({ request: attemptedRequest, item, refreshed: true });
              setConfirmOpen(true);
              return false;
            }
          } catch {
            // Preview unreachable — fall through to the plain refusal toast.
          }
          toast.error(tIssues(($) => $.comment.trigger_blocked_dependency_unsatisfied));
          return false;
        }
        if (
          depDetails.reasonCode === "dependency_cycle" ||
          depDetails.reasonCode === "dependency_ancestor_conflict"
        ) {
          toast.error(t(($) => $.create_issue.dependency_structure_error));
          return false;
        }
        if (depDetails.reasonCode === "dependency_data_unverified") {
          toast.error(t(($) => $.create_issue.dependency_unverified_error));
          return false;
        }
      }
      // A 404/405 on a relation-carrying create means the server predates the
      // compound endpoint: report the missing capability — never fall back to
      // the legacy create, which would silently drop the prerequisites (OL-41).
      if (
        attemptedRequest?.blockedBy !== undefined &&
        err instanceof ApiError &&
        (err.status === 404 || err.status === 405)
      ) {
        toast.error(t(($) => $.create_issue.dependency_unsupported));
        return false;
      }
      // Duplicate-issue is the only structured 409 the create endpoint
      // returns. We schema-guard the body (ApiError.body is `unknown`) so a
      // future server-side rename / drop of `code` / `issue` degrades to the
      // normal error toast instead of throwing inside the toast renderer.
      if (err instanceof ApiError && err.status === 409) {
        const dup = parseWithFallback<DuplicateIssueErrorBody | null>(
          err.body,
          DuplicateIssueErrorBodySchema,
          null,
          { endpoint: "POST /api/workspaces/:wsId/issues (active_duplicate_issue)" },
        );
        if (dup) {
          toast.custom(
            (toastId) => (
              <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 w-[360px]">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex items-center justify-center size-5 rounded-full bg-amber-500/15 text-amber-500">
                    <AlertTriangle className="size-3" />
                  </div>
                  <span className="text-body font-medium">
                    {t(($) => $.create_issue.toast_duplicate_title)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-body text-muted-foreground ml-7">
                  <span className="truncate">{dup.issue.identifier} – {dup.issue.title}</span>
                </div>
                {/* See the created-issue toast above: toast content lives
                    outside NavigationProvider, so this stays a button. */}
                <button
                  type="button"
                  className="ml-7 mt-2 text-body text-primary hover:underline cursor-pointer"
                  onClick={() => {
                    router.push(p.issueDetail(dup.issue.id));
                    toast.dismiss(toastId);
                  }}
                >
                  {t(($) => $.create_issue.toast_duplicate_view)}
                </button>
              </div>
            ),
            { duration: 5000 },
          );
          return false;
        }
      }
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.create_issue.toast_failed),
      );
      return false;
    }
  },
    onAccepted: acceptSubmittedDraft,
  });

  // Button + shortcut entry point. The title-empty case can't rely on the
  // button tooltip (shortcuts bypass the button), so focus the title to point
  // at the fix; otherwise hand off to the composer (single-flight + gate live
  // there).
  const handleSubmit = () => {
    if (anchorCommentId && !sourcePreview) return;
    if (!title.trim()) {
      titleEditorRef.current?.focus();
      return;
    }
    void composer.submit();
  };
  const submitting = composer.submitting;

  // Switch to agent mode WITHOUT destroying the manual draft. The manual slot
  // (title, description, …) is left untouched so a later agent→manual flip
  // restores it verbatim. Project / priority / due date already live in the
  // shared slot, so they carry across for free. Only two things are handed to
  // the agent panel:
  //   1. A one-time assist-init of the agent prompt / actor: when the agent
  //      draft is still empty, seed the prompt from title + description and the
  //      actor from the manual assignee (if agent-like). An existing agent
  //      draft is preserved — no repeated concatenate-then-clobber.
  //   2. The parent-issue context, which is not persisted in the draft (it is a
  //      per-invocation intent from "Add sub issue"), so it rides the carry.
  const switchToAgent = () => {
    // Serializing mid-upload packs a description that has already lost the
    // pending image into the agent prompt, so gate the switch too.
    if (gate.isBlocked()) return;
    // Commit the shared fields to the draft so the agent panel reads them from
    // there. Local state can hold a value seeded from `data` (e.g. an opener's
    // project) that was never written through a picker, so a plain flip would
    // otherwise drop it.
    setShared({ projectId, priority, dueDate });
    const existingPrompt = draft.agent.prompt;
    if (!existingPrompt.trim()) {
      const desc = descEditorRef.current?.getMarkdown()?.trim() ?? "";
      const seeded = [title.trim(), desc].filter(Boolean).join("\n\n");
      if (seeded) setAgent({ prompt: seeded });
    }
    if (
      !draft.agent.actorId &&
      assigneeId &&
      (assigneeType === "agent" || assigneeType === "squad")
    ) {
      setAgent({ actorType: assigneeType, actorId: assigneeId });
    }
    setLastMode("agent");
    setActiveMode("agent");
    // Prefer the hydrated identifier from `parentIssue`, but fall back to the
    // identifier the modal opener seeded on `data`. Without the fallback, a
    // flip that happens before the issue detail query resolves drops the
    // identifier and the agent chip renders as "Sub-issue of " with an empty
    // tail. The UUID alone still wires the sub-issue relationship correctly;
    // this only affects the display affordance.
    const carryParentIdentifier =
      parentIssue?.identifier ?? (data?.parent_issue_identifier as string | undefined);
    const carry: Record<string, unknown> = {};
    if (parentIssueId) carry.parent_issue_id = parentIssueId;
    if (carryParentIdentifier) carry.parent_issue_identifier = carryParentIdentifier;
    onSwitchMode?.(Object.keys(carry).length > 0 ? carry : null);
  };

  // One state for the button and the keyboard paths, so a rendered affordance
  // can never disagree with what `handleSubmit` will actually do.
  const submitState: "submitting" | "uploading" | "missing_title" | "source_unavailable" | "ready" =
    submitting
      ? "submitting"
      : gate.uploading
        ? "uploading"
        : anchorCommentId && !sourcePreview
          ? "source_unavailable"
          : !title.trim()
            ? "missing_title"
            : "ready";
  const submitBusy = submitState === "submitting" || submitState === "uploading";

  // Built once and reused by both footer branches: rendering a separate Button
  // per branch is how the keycaps drifted out of one of them before.
  const createButton = (
    <Button
      size="sm"
      onClick={handleSubmit}
      // Native `disabled` for the transient busy states, but `aria-disabled`
      // for a missing title — a native-disabled button is not focusable, so
      // keyboard and screen-reader users could never reach the tooltip that
      // explains why nothing happens. `handleSubmit` is the real gate either way.
      disabled={submitBusy}
      aria-disabled={submitState === "missing_title" || submitState === "source_unavailable" || undefined}
      aria-busy={submitBusy || undefined}
      // The Button base only dims/blocks on native `disabled`, so aria-disabled
      // would otherwise stay a fully lit, pressable-looking primary button.
      // Deliberately no `pointer-events-none`: this control still has to hover
      // its tooltip and take the click that focuses the title.
      className="justify-self-end aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:active:translate-y-0"
    >
      {submitState === "submitting" ? (
        t(($) => $.create_issue.submitting)
      ) : submitState === "uploading" ? (
        tEditor(($) => $.upload.in_progress)
      ) : (
        <>
          {t(($) => $.create_issue.submit)}
          {/* Decorative: the accessible name must stay "Create Issue", not
              "Create Issue Command Enter". Absent when `send` is unbound.
              Hidden on phones — no ⌘ key there, and the footer row is at its
              tightest. */}
          {sendShortcut ? (
            <ShortcutKeycaps
              shortcut={sendShortcut}
              decorative
              className="ml-1 max-sm:hidden"
              keyClassName="border-background/30 bg-background/15 text-primary-foreground shadow-none"
            />
          ) : null}
        </>
      )}
    </Button>
  );

  return (
    <>
            <DialogTitle className="sr-only">{t(($) => $.create_issue.sr_manual)}</DialogTitle>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0">
              <div className="flex items-center gap-1.5 text-caption">
                <span className="text-muted-foreground">{workspaceName}</span>
                <ChevronRight className="size-3 text-faint-foreground" />
                <span className="font-medium">{t(($) => $.create_issue.manual_breadcrumb)}</span>
              </div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent/60 transition-all cursor-pointer"
                      >
                        {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">
                    {isExpanded
                      ? t(($) => $.common.collapse_tooltip)
                      : t(($) => $.common.expand_tooltip)}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={onClose}
                        className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent/60 transition-all cursor-pointer"
                      >
                        <XIcon className="size-4" />
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">{t(($) => $.common.close)}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Title */}
            <div className="px-5 pb-2 shrink-0">
              <TitleEditor
                key={formResetKey}
                ref={titleEditorRef}
                autoFocus
                defaultValue={draft.manual.title}
                placeholder={t(($) => $.create_issue.title_placeholder)}
                className="text-title font-semibold"
                onChange={(v) => updateTitle(v)}
                // Chord only — plain Enter still just ends title editing (#5532).
                onSubmitShortcut={handleSubmit}
              />
            </div>

            {/* Description — takes remaining space */}
            <div {...descDropZoneProps} className="relative flex flex-1 min-h-0 overflow-y-auto px-5">
              <ContentEditor
                ref={descEditorRef}
                defaultValue={draft.manual.description}
                placeholder={t(($) => $.create_issue.description_placeholder)}
                onUpdate={(md) => setManual({ description: md })}
                onSubmit={handleSubmit}
                onUploadFile={handleUpload}
                onUploadingChange={uploadGate.onUploadingChange}
                debounceMs={500}
                attachments={draftAttachments}
              />
              {descDragOver && <FileDropOverlay />}
            </div>

            {anchorCommentId && (
              <SourceContextPreviewCard
                preview={sourcePreview}
                loading={sourceContextLoading}
                failed={sourceContextFailed}
                error={sourceContextError}
                onRetry={refetchSourceContext ? () => { void refetchSourceContext(); } : undefined}
                constrainToParent
                expanded={sourceContextExpanded}
                onExpandedChange={onSourceContextExpandedChange}
              />
            )}

            {/* Pre-trigger preview — a passive caption above the toolbar; reveals
                when an agent assignee will pick the issue up, and warns when
                queued prerequisites would block that start. */}
            <CreateRunHint
              assigneeType={assigneeType}
              assigneeId={assigneeId}
              status={status}
              parentIssueId={parentIssueId}
              blockedBy={blockedByIds}
            />

            {/* Property toolbar — each field renders per the Settings → Preferences → Issue creation
                selection (see showField above). */}
            <div className="flex items-center gap-1.5 px-4 py-2 shrink-0 flex-wrap">
              {/* Status */}
              {showField.status && (
                <StatusPicker
                  status={status}
                  onUpdate={(u) => { if (u.status) updateStatus(u.status); }}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "status" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "status" : null)}
                />
              )}

              {/* Priority */}
              {showField.priority && (
                <PriorityPicker
                  priority={priority}
                  onUpdate={(u) => { if (u.priority) updatePriority(u.priority); }}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "priority" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "priority" : null)}
                />
              )}

              {/* Assignee */}
              {showField.assignee && (
                <AssigneePicker
                  assigneeType={assigneeType ?? null}
                  assigneeId={assigneeId ?? null}
                  onUpdate={(u) => updateAssignee(
                    u.assignee_type ?? undefined,
                    u.assignee_id ?? undefined,
                  )}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "assignee" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "assignee" : null)}
                />
              )}

              {/* Labels — occupies the slot that used to hold Due date so the
                  add-label entry is exposed directly on the dialog. Draft mode:
                  selection is local until the issue is created (handleSubmit
                  attaches the labels afterward). */}
              {showField.labels && (
                <LabelPicker
                  selectedIds={labelIds}
                  onSelectedIdsChange={updateLabelIds}
                  triggerRender={<PillButton />}
                  align="start"
                  open={fieldPickerOpen === "labels" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "labels" : null)}
                />
              )}

              {/* Project */}
              {showField.project && (
                <ProjectPicker
                  projectId={projectId ?? null}
                  onUpdate={(u) => updateProject(u.project_id ?? undefined)}
                  triggerRender={
                    <ClearablePillButton
                      onClear={projectId ? () => updateProject(undefined) : undefined}
                      clearLabel={tProjects(($) => $.picker.clear_aria)}
                    />
                  }
                  align="start"
                  open={fieldPickerOpen === "project" ? true : undefined}
                  onOpenChange={(open) => setFieldPickerOpen(open ? "project" : null)}
                />
              )}

              {/* Stage — only relevant when creating a sub-issue under a parent */}
              {parentIssueId && (
                <StagePicker
                  stage={stage}
                  onUpdate={(u) => setStage(u.stage ?? null)}
                  maxStage={maxSiblingStage(parentChildren)}
                  triggerRender={<PillButton />}
                  align="start"
                />
              )}

              {/* Start date — collapsed into the ⋯ menu by default since it's
                  a low-frequency field (exposable via Settings → Preferences → Issue creation).
                  Renders inline when configured visible, when the field has a
                  value, OR when the user just opened it from the overflow
                  menu (the picker's calendar popover needs the inline pill
                  as its anchor). */}
              {showField.start_date && (
                <StartDatePicker
                  startDate={startDate}
                  onUpdate={(u) => updateStartDate(u.start_date ?? null)}
                  triggerRender={<PillButton />}
                  align="start"
                  open={startDatePickerOpen}
                  onOpenChange={setStartDatePickerOpen}
                />
              )}

              {/* Due date — collapsed into the ⋯ menu by default (moved off
                  the toolbar to make room for Labels). Same reveal rule as
                  start date. */}
              {showField.due_date && (
                <DueDatePicker
                  dueDate={dueDate}
                  onUpdate={(u) => updateDueDate(u.due_date ?? null)}
                  triggerRender={<PillButton />}
                  align="start"
                  open={dueDatePickerOpen}
                  onOpenChange={setDueDatePickerOpen}
                />
              )}

              {/* Workspace-defined fields use the same typed editors as issue
                  detail, but write into the persisted draft until creation. */}
              {workspaceProperties
                .filter(
                  (property) =>
                    Object.prototype.hasOwnProperty.call(propertyValues, property.id) ||
                    customPropertyPickerId === property.id,
                )
                .map((property) => {
                  const value = propertyValues[property.id];
                  return (
                    <CustomPropertyValueInput
                      key={property.id}
                      property={property}
                      value={value}
                      onChange={(next) => updatePropertyValue(property.id, next)}
                      open={customPropertyPickerId === property.id}
                      onOpenChange={(open) =>
                        setCustomPropertyPickerId(open ? property.id : null)
                      }
                      triggerRender={<PillButton />}
                      trigger={
                        <>
                          <PropertyIcon property={property} className="size-3.5 text-caption" />
                          <span className="max-w-32 truncate">{property.name}</span>
                          {value !== undefined && (
                            <span className="max-w-40 truncate text-muted-foreground">
                              <CustomPropertyValueDisplay property={property} value={value} />
                            </span>
                          )}
                        </>
                      }
                    />
                  );
                })}

              {/* Parent chip — appears when parent is set.
                  Placed before the ⋯ so it wraps to a new line with ⋯ if
                  space is tight, but ⋯ always stays last in DOM order. */}
              {parentIssueId && parentIssueLocked ? (
                <span
                  data-testid="manual-sub-issue-chip"
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground"
                >
                  {t(($) => $.create_issue.subissue_of, {
                    identifier: parentIssue?.identifier
                      ?? (data?.parent_issue_identifier as string | undefined)
                      ?? "",
                  })}
                </span>
              ) : parentIssueId && parentIssue ? (
                <div className="inline-flex items-center rounded-full border text-caption transition-colors hover:bg-accent/60">
                  <button
                    type="button"
                    onClick={() => setParentPickerOpen(true)}
                    className="flex items-center gap-1.5 py-1 pl-2.5 cursor-pointer"
                  >
                    <ArrowUp className="size-3 text-muted-foreground" />
                    <span>
                      {t(($) => $.create_issue.subissue_of, { identifier: parentIssue.identifier })}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setParentIssueId(undefined)}
                    className="p-1 pr-2 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={t(($) => $.create_issue.remove_parent_aria)}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ) : null}

              {/* Child chips — one per queued sub-issue. Links are deferred
                  until create resolves (see handleSubmit). */}
              {childIssues.map((c) => (
                <div
                  key={c.id}
                  className="inline-flex items-center rounded-full border text-caption transition-colors hover:bg-accent/60"
                >
                  <div className="flex items-center gap-1.5 py-1 pl-2.5">
                    <ArrowDown className="size-3 text-muted-foreground" />
                    <span>{t(($) => $.create_issue.subissue_chip, { identifier: c.identifier })}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setChildIssues((prev) => prev.filter((x) => x.id !== c.id))
                    }
                    className="p-1 pr-2 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={t(($) => $.create_issue.remove_subissue_aria, { identifier: c.identifier })}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}

              {/* Prerequisite chips — one per queued blocked_by edge, sent with
                  the create in the same compound write (OL-44). */}
              {blockedByIds.map((b, i) => (
                <div
                  key={b}
                  className="inline-flex items-center rounded-full border text-caption transition-colors hover:bg-accent/60"
                >
                  <div className="flex items-center gap-1.5 py-1 pl-2.5">
                    <Workflow className="size-3 text-muted-foreground" />
                    <span>{t(($) => $.create_issue.prerequisite_chip, { identifier: blockedByLabelOf(b, i) })}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      updateBlockedBy(blockedByIds.filter((x) => x !== b))
                    }
                    className="p-1 pr-2 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={t(($) => $.create_issue.remove_prerequisite_aria, { identifier: blockedByLabelOf(b, i) })}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}

              {/* Overflow — always the last child so DOM order keeps it at the
                  end of the wrap flow, no matter how many chips are present. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <PillButton aria-label={t(($) => $.create_issue.more_options_aria)}>
                      <MoreHorizontal className="size-3.5" />
                    </PillButton>
                  }
                />
                <DropdownMenuContent align="start" className="w-auto">
                  {/* Re-entry points for toolbar fields hidden via
                      Settings → Preferences → Issue creation. Listed in toolbar order; each opens
                      the picker inline (mounting the pill as its anchor). */}
                  {!showField.status && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("status")}>
                      <StatusIcon
                        status={status}
                        category={draftStatusCategory(status)}
                        className="h-3.5 w-3.5"
                      />
                      {t(($) => $.create_issue.set_status)}
                    </DropdownMenuItem>
                  )}
                  {!showField.priority && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("priority")}>
                      <PriorityIcon priority="none" className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_priority)}
                    </DropdownMenuItem>
                  )}
                  {!showField.assignee && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("assignee")}>
                      <CircleUser className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_assignee)}
                    </DropdownMenuItem>
                  )}
                  {!showField.labels && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("labels")}>
                      <Tag className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_labels)}
                    </DropdownMenuItem>
                  )}
                  {!showField.project && (
                    <DropdownMenuItem onClick={() => setFieldPickerOpen("project")}>
                      <FolderKanban className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_project)}
                    </DropdownMenuItem>
                  )}
                  {!showField.due_date && (
                    <DropdownMenuItem onClick={() => setDueDatePickerOpen(true)}>
                      <CalendarDays className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_due_date)}
                    </DropdownMenuItem>
                  )}
                  {!showField.start_date && (
                    <DropdownMenuItem onClick={() => setStartDatePickerOpen(true)}>
                      <CalendarClock className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_start_date)}
                    </DropdownMenuItem>
                  )}
                  {!parentIssueLocked && (parentIssueId && parentIssue ? (
                    <DropdownMenuItem onClick={() => setParentPickerOpen(true)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.parent_with_id, { identifier: parentIssue.identifier })}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => setParentPickerOpen(true)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.set_parent)}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={() => setChildPickerOpen(true)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                    {t(($) => $.create_issue.add_subissue)}
                  </DropdownMenuItem>
                  {/* Prerequisites are unavailable in the comment sub-issue
                      flow: that endpoint has no blocked_by, so the entry stays
                      hidden there instead of pretending to apply. */}
                  {!anchorCommentId && (
                    <DropdownMenuItem onClick={() => setBlockedByPickerOpen(true)}>
                      <Workflow className="h-3.5 w-3.5" />
                      {t(($) => $.create_issue.add_prerequisite)}
                    </DropdownMenuItem>
                  )}
                  {workspaceProperties.length > 0 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Shapes className="h-3.5 w-3.5" />
                        {t(($) => $.create_issue.custom_properties)}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-56">
                        {workspaceProperties.map((property) => (
                          <DropdownMenuItem
                            key={property.id}
                            disabled={Object.prototype.hasOwnProperty.call(
                              propertyValues,
                              property.id,
                            )}
                            onClick={() => setCustomPropertyPickerId(property.id)}
                          >
                            <PropertyIcon property={property} className="size-3.5 text-caption" />
                            <span className="truncate">{property.name}</span>
                            {Object.prototype.hasOwnProperty.call(
                              propertyValues,
                              property.id,
                            ) && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuSeparator />
                  {/* Field visibility lives in Settings → Preferences → Issue creation; the modal
                      closes first so the dialog doesn't linger over the
                      settings page. The draft store already holds everything
                      typed, so nothing is lost across the round-trip. */}
                  <DropdownMenuItem
                    render={
                      <AppLink
                        href={`${p.settings()}?tab=preferences&section=issue`}
                        onClick={(e) => {
                          // A modifier click opens Settings in another tab —
                          // the modal (and the draft in it) stays put. Only
                          // an in-place navigation closes it.
                          if (resolveClickIntent(e) !== "push") return;
                          onClose();
                        }}
                      />
                    }
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    {t(($) => $.create_issue.customize_fields)}
                  </DropdownMenuItem>
                  {!parentIssueLocked && parentIssueId && parentIssue && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setParentIssueId(undefined)}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                        {t(($) => $.create_issue.remove_parent)}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Parent / child pickers — rendered inline so they stack over this
                modal instead of replacing it via useModalStore. */}
            <IssuePickerModal
              open={parentPickerOpen}
              onOpenChange={setParentPickerOpen}
              title={t(($) => $.create_issue.set_parent_picker.title)}
              description={t(($) => $.create_issue.set_parent_picker.description)}
              excludeIds={[
                ...childIssues.map((c) => c.id),
                ...(parentIssueId ? [parentIssueId] : []),
              ]}
              onSelect={(selected) => {
                setParentIssueId(selected.id);
              }}
            />
            <IssuePickerModal
              open={childPickerOpen}
              onOpenChange={setChildPickerOpen}
              title={t(($) => $.create_issue.add_subissue_picker.title)}
              description={t(($) => $.create_issue.add_subissue_picker.description)}
              excludeIds={[
                ...childIssues.map((c) => c.id),
                ...(parentIssueId ? [parentIssueId] : []),
              ]}
              onSelect={(selected) => {
                setChildIssues((prev) =>
                  prev.some((x) => x.id === selected.id) ? prev : [...prev, selected],
                );
              }}
            />
            {/* Prerequisite picker — the parent and queued children are
                excluded because ancestor↔descendant edges are structural
                conflicts the server rejects anyway. */}
            <IssuePickerModal
              open={blockedByPickerOpen}
              onOpenChange={setBlockedByPickerOpen}
              title={t(($) => $.create_issue.prerequisite_picker.title)}
              description={t(($) => $.create_issue.prerequisite_picker.description)}
              excludeIds={[
                ...blockedByIds,
                ...childIssues.map((c) => c.id),
                ...(parentIssueId ? [parentIssueId] : []),
              ]}
              onSelect={(selected) => {
                updateBlockedBy(
                  blockedByIds.includes(selected.id)
                    ? blockedByIds
                    : [...blockedByIds, selected.id],
                );
              }}
            />

            {/* One-shot human release for a create blocked by unfinished
                prerequisites (OL-41). The listed body is byte-for-byte the one
                the preview signed; confirming replays it with the challenge.
                Closing keeps the permit in the draft store — an undetermined
                attempt is restored on resubmit, never silently re-minted. */}
            {confirmOpen && pendingDependencyCreate && (
              <Dialog
                open
                onOpenChange={(v) => {
                  if (!v && !overrideCreating) setConfirmOpen(false);
                }}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {t(($) => $.create_issue.dependency_confirm.title)}
                    </DialogTitle>
                    <DialogDescription>
                      {t(($) => $.create_issue.dependency_confirm.body)}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    <div className="flex items-center gap-1.5 text-caption font-medium text-warning">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      {t(($) => $.run_confirm.blocked_title)}
                    </div>
                    <DependencyBlockedList
                      wsId={wsId}
                      items={[pendingDependencyCreate.item]}
                      onOpenIssue={(targetId) => {
                        // Inspecting a blocker leaves the form; the draft AND
                        // the pending permit persist for reopening.
                        router.push(p.issueDetail(targetId));
                        setConfirmOpen(false);
                        onClose();
                      }}
                    />
                    <p className="text-micro text-muted-foreground">
                      {t(($) => $.run_confirm.blocked_one_time_note)}
                    </p>
                    {pendingDependencyCreate.refreshed && (
                      <p className="text-micro text-warning">
                        {t(($) => $.run_confirm.stale_notice)}
                      </p>
                    )}
                    {pendingDependencyCreate.uncertain && (
                      <p className="text-micro text-warning">
                        {t(($) => $.create_issue.dependency_confirm.uncertain_note)}
                      </p>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={overrideCreating}
                      onClick={() => setConfirmOpen(false)}
                    >
                      {t(($) => $.create_issue.dependency_confirm.cancel)}
                    </Button>
                    <Button
                      type="button"
                      disabled={overrideCreating || !pendingDependencyCreate.item.confirmation}
                      onClick={() => void submitDependencyOverride()}
                    >
                      {overrideCreating ? (
                        <Spinner className="size-4" />
                      ) : (
                        t(($) => $.create_issue.dependency_confirm.confirm)
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}

            {/* Footer — same 2x2-grid-on-phones / single-row-from-`sm` shape
                as the agent panel; see the note on AgentCreatePanel's footer
                for why (MUL-6236). TooltipProvider/Tooltip render no DOM and
                TooltipContent is portaled, so the Create button stays a direct
                grid child in both branches below. */}
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2.5 border-t px-4 py-3 shrink-0 sm:flex sm:flex-wrap">
              <div className="flex min-h-7 items-center gap-2 sm:mr-auto">
                <FileUploadButton
                  size="sm"
                  multiple
                  onSelect={(file) => descEditorRef.current?.uploadFile(file)}
                />
              </div>
              <button
                type="button"
                onClick={switchToAgent}
                disabled={gate.uploading}
                aria-disabled={gate.uploading || undefined}
                aria-busy={gate.uploading || undefined}
                title={t(($) => $.create_issue.switch_to_agent_tooltip)}
                className="border-beam group flex shrink-0 items-center gap-1.5 justify-self-end text-caption px-2 py-1 rounded-sm text-muted-foreground bg-brand/5 hover:bg-brand/10 hover:text-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowLeftRight className="size-3.5 text-brand transition-transform duration-300 group-hover:rotate-180" />
                {t(($) => $.create_issue.switch_to_agent)}
              </button>
              <label className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground cursor-pointer select-none">
                <Switch
                  size="sm"
                  checked={keepOpen}
                  onCheckedChange={setKeepOpen}
                />
                {t(($) => $.create_issue.create_another)}
              </label>
              {submitState === "missing_title" ? (
                <TooltipProvider delay={200}>
                  <Tooltip>
                    {/* No `<span>` wrapper needed now: aria-disabled leaves the
                        button focusable and hoverable, so it can anchor its own
                        tooltip. */}
                    <TooltipTrigger render={createButton} />
                    <TooltipContent side="top">{t(($) => $.create_issue.title_required)}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                createButton
              )}
            </div>
    </>
  );
}

/** className for DialogContent in manual mode — depends on isExpanded.
 *  Exported so the shell (which now owns the DialogContent) can apply the same
 *  visual treatment without duplicating it. */
export function manualDialogContentClass(isExpanded: boolean) {
  return cn(
    "p-0 gap-0 flex flex-col overflow-hidden",
    "!top-1/2 !left-1/2 !-translate-x-1/2",
    "!transition-all !duration-300 !ease-out",
    // Phone gutter — see the matching note in create-issue-dialog.tsx: the
    // `!important` widths below also override DialogContent's
    // `max-w-[calc(100%-2rem)]`, leaving the card edge to edge on a phone
    // (MUL-6236). `!h-96` stays a hard height; it already fits the shortest
    // phone we support.
    "!w-full !max-w-[calc(100vw-1.5rem)]",
    isExpanded
      ? "!h-5/6 !-translate-y-1/2 sm:!max-w-4xl"
      : "!h-96 !-translate-y-1/2 sm:!max-w-2xl",
  );
}

// Thin Dialog-wrapping export — registry mounts the panel directly under the
// shell's shared Dialog, but a few legacy callers (and the test suite) still
// import this module's modal version. Equivalent runtime behavior to the
// pre-refactor component when used standalone.
import { Dialog as DialogRoot } from "@multica/ui/components/ui/dialog";
export function CreateIssueModal(props: {
  onClose: () => void;
  data?: Record<string, unknown> | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <DialogRoot open onOpenChange={(v) => { if (!v) props.onClose(); }}>
      <DialogContent
        finalFocus={false}
        showCloseButton={false}
        className={manualDialogContentClass(isExpanded)}
      >
        <ManualCreatePanel
          {...props}
          isExpanded={isExpanded}
          setIsExpanded={setIsExpanded}
        />
      </DialogContent>
    </DialogRoot>
  );
}
