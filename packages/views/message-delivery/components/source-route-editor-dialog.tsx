"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  messageSourceRoutesOptions,
  useApproveMessageSourceTarget,
  useCreateMessageSourceRoute,
  useUpdateMessageSourceRoute,
} from "@multica/core/message-delivery";
import { useWorkspaceId } from "@multica/core/hooks";
import { errorCode } from "@multica/core/api";
import type {
  MessageEventCatalog,
  MessageSourceApprovedTarget,
  MessageSourceRoute,
  MessageTargetType,
  SaveMessageSourceRouteRequest,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
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
import { toast } from "sonner";
import { useT } from "../../i18n";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  isSourceTargetApproved,
  messageDeliveryErrorKey,
  messageTargetKey,
  personalEventTypeKey,
  teamEventKey,
  type PersonalEventTypeKey,
  type TeamEventKey,
} from "../copy";

const TEAM_KINDS = ["activity", "comment"] as const;
const TEAM_TARGET_TYPES = ["group", "topic"] as const;

/**
 * Editor for one personal/team notification route (OL-27). Separate from the
 * automation editor on purpose: this surface has no conditions/content_mode,
 * a personal route's recipient is always the acting member (server-pinned,
 * never a form input), and team approvals match the exact
 * (source kind, project range, bot, target) scope — changing any dimension
 * stops showing an old approval as applicable.
 *
 * The 409 contract mirrors the automation editor: on route_revision_conflict
 * the latest committed route is refetched and adopted in full (every form
 * field, not just the revision); only a found-and-adopted reload re-enables
 * saving, and a failed reload or an elsewhere-deleted route blocks the stale
 * draft with an honest state.
 */
export function SourceRouteEditorDialog({
  open,
  onOpenChange,
  mode,
  route,
  installations,
  approvals,
  projects,
  catalog,
  catalogError = false,
  onCatalogRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** personal = the acting member's own inbox DM; team = activity/comment to a group/topic (owner/admin only). */
  mode: "personal" | "team";
  /** null → create mode. */
  route: MessageSourceRoute | null;
  installations: { id: string; agent_id: string; status: string; region?: string | null }[];
  /** Team mode only: active team approvals for exact-scope matching. */
  approvals?: MessageSourceApprovedTarget[];
  /** Team mode only: project options for the scope picker. */
  projects?: { id: string; title: string }[];
  catalog: MessageEventCatalog | undefined;
  /** True when the catalog request failed. The event filter cannot be
   * expressed without the catalog, so saving is blocked until a retry
   * succeeds — an empty event_types means "forward everything" and must
   * never be submitted by default. */
  catalogError?: boolean;
  onCatalogRetry?: () => void;
}) {
  const { t } = useT("message-delivery");
  const { getActorName } = useActorName();
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const createRoute = useCreateMessageSourceRoute();
  const updateRoute = useUpdateMessageSourceRoute();
  const approveTarget = useApproveMessageSourceTarget();

  const [currentRoute, setCurrentRoute] = useState<MessageSourceRoute | null>(route);
  // Post-409 reload outcome: only "adopted" may claim freshness; the other
  // states keep the stale draft blocked behind an honest message.
  const [conflict, setConflict] = useState<
    "reloading" | "adopted" | "reload_failed" | "gone" | null
  >(null);

  const activeInstallations = installations.filter((inst) => inst.status === "active");

  const [sourceKind, setSourceKind] = useState<string>(
    route?.source_kind ?? (mode === "personal" ? "inbox" : "activity"),
  );
  const [installationId, setInstallationId] = useState(
    route?.installation_id ?? activeInstallations[0]?.id ?? "",
  );
  const [projectId, setProjectId] = useState<string>(route?.project_id ?? "");
  const [targetType, setTargetType] = useState<MessageTargetType>(
    route?.target_type ?? (mode === "personal" ? "member" : "group"),
  );
  const [targetChatId, setTargetChatId] = useState(route?.target_chat_id ?? "");
  const [targetMessageId, setTargetMessageId] = useState(route?.target_message_id ?? "");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(route?.event_types ?? []);
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [error, setError] = useState<unknown>(null);

  const isTeam = mode === "team";
  const isExternal = isTeam && (targetType === "group" || targetType === "topic");

  const typedKey = useMemo(
    () =>
      messageTargetKey(targetType, {
        chatId: targetChatId.trim(),
        messageId: targetMessageId.trim(),
      }),
    [targetType, targetChatId, targetMessageId],
  );
  // Exact-scope approval matching: a different source kind, a different
  // project range (workspace-wide vs project) or another bot must NOT show
  // an old approval as still applicable.
  const isApproved = useMemo(
    () =>
      !isExternal
        ? false
        : isSourceTargetApproved(approvals ?? [], {
            sourceKind,
            projectId: projectId === "" ? null : projectId,
            installationId,
            targetKey: typedKey,
          }),
    [approvals, isExternal, sourceKind, projectId, installationId, typedKey],
  );
  // Team configuration is owner/admin-only, so an unapproved external target
  // is always approved inline in the same submit; the button label says so.
  const willApprove = isExternal && !isApproved;

  // Event options come from the server catalog, never hardcoded; a type the
  // UI has no translation for keeps the server's English label.
  const eventOptions = useMemo(() => {
    if (!catalog) return [];
    if (!isTeam) {
      return catalog.personal.event_types.map((e) => ({
        value: e.type,
        i18nKey: personalEventTypeKey(e.type),
        fallback: e.label,
      }));
    }
    const entry = catalog.team.find((team) => team.source_kind === sourceKind);
    return (entry?.events ?? []).map((e) => ({
      value: e.event,
      i18nKey: teamEventKey(e.event),
      fallback: e.label,
    }));
  }, [catalog, isTeam, sourceKind]);

  const valid =
    installationId !== "" &&
    (!isTeam ||
      (targetType === "group"
        ? targetChatId.trim() !== ""
        : targetChatId.trim() !== "" && targetMessageId.trim() !== ""));

  const saving =
    createRoute.isPending || updateRoute.isPending || approveTarget.isPending ||
    conflict === "reloading";
  const saveBlockedByConflict =
    conflict === "reloading" || conflict === "reload_failed" || conflict === "gone";
  // Without the catalog the event filter cannot be expressed: an empty
  // event_types means "forward everything" and must never be submitted by
  // default. Block saving while the catalog is missing (loading or failed)
  // AND when a refresh failed with retained (now unverifiable) data — the
  // error state means the options on screen are not confirmed current.
  const saveBlockedByCatalog = catalog == null || catalogError;

  const toggleEvent = (value: string, checked: boolean) => {
    setSelectedEvents((prev) =>
      checked ? [...prev, value] : prev.filter((v) => v !== value),
    );
  };

  // Adopt the other writer's committed version in full — every form field,
  // not just the revision lock — so a re-save never silently overwrites
  // changes the user never saw.
  const reloadAfterConflict = async (routeId: string) => {
    setConflict("reloading");
    try {
      // fetchQuery returns the raw envelope (select is observer-only). The
      // unfiltered list always contains the acting member's own inbox rules
      // and, for owners/admins, the team rules.
      const fresh = await qc.fetchQuery(messageSourceRoutesOptions(wsId));
      const found = fresh.routes.find((r: MessageSourceRoute) => r.id === routeId);
      if (!found) {
        setConflict("gone");
        return;
      }
      setCurrentRoute(found);
      setSourceKind(found.source_kind);
      setInstallationId(found.installation_id);
      setProjectId(found.project_id ?? "");
      setTargetType(found.target_type);
      setTargetChatId(found.target_chat_id ?? "");
      setTargetMessageId(found.target_message_id ?? "");
      setSelectedEvents(found.event_types);
      setConflict("adopted");
    } catch {
      setConflict("reload_failed");
    }
  };

  const handleSave = async () => {
    setError(null);
    // A new save ends the previous round's "adopted latest" notice — the
    // result of THIS attempt (success or its own error) is what must show.
    if (conflict === "adopted") setConflict(null);
    const payload: SaveMessageSourceRouteRequest = {
      source_kind: sourceKind,
      installation_id: installationId,
      target_type: targetType,
      // Empty selection = every event of the scope; sorted so a reorder is
      // never a behavior change.
      event_types: [...selectedEvents].sort(),
      ...(isTeam
        ? {
            project_id: projectId === "" ? null : projectId,
            target_chat_id: targetChatId.trim(),
            ...(targetType === "topic"
              ? { target_message_id: targetMessageId.trim() }
              : {}),
          }
        : {}),
    };
    try {
      if (willApprove) {
        await approveTarget.mutateAsync({
          source_kind: sourceKind,
          project_id: projectId === "" ? null : projectId,
          installation_id: installationId,
          target_type: targetType,
          target_chat_id: targetChatId.trim(),
          ...(targetType === "topic"
            ? { target_message_id: targetMessageId.trim() }
            : {}),
        });
      }
      if (currentRoute) {
        await updateRoute.mutateAsync({
          routeId: currentRoute.id,
          ...payload,
          expected_revision: currentRoute.revision,
        });
      } else {
        await createRoute.mutateAsync({ ...payload, enabled });
      }
      toast.success(t(($) => $.routes.toast_saved));
      onOpenChange(false);
    } catch (e) {
      // Stays inside the dialog — a failed save must not look like a saved,
      // enabled rule anywhere else on the page.
      if (errorCode(e) === "route_revision_conflict" && currentRoute) {
        await reloadAfterConflict(currentRoute.id);
      }
      setError(e);
    }
  };

  const errCode = errorCode(error);
  let errorMessage: string | null = null;
  if (conflict === "adopted") {
    errorMessage = t(($) => $.editor.conflict);
  } else if (conflict === "gone") {
    errorMessage = t(($) => $.editor.conflict_gone);
  } else if (conflict === "reload_failed" || conflict === "reloading") {
    errorMessage = t(($) => $.editor.conflict_reload_failed);
  } else if (error != null) {
    errorMessage =
      errCode === "route_revision_conflict"
        ? t(($) => $.editor.conflict)
        : t(($) => $.error[messageDeliveryErrorKey(errCode)]);
  }

  const title = currentRoute
    ? isTeam
      ? t(($) => $.source_editor.title_edit_team)
      : t(($) => $.source_editor.title_edit_personal)
    : isTeam
      ? t(($) => $.source_editor.title_add_team)
      : t(($) => $.source_editor.title_add_personal);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogTitle>{title}</DialogTitle>
        <div className="space-y-4 pt-1">
          {isTeam && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.source_editor.kind)}
              </label>
              <Select
                items={TEAM_KINDS.map((v) => ({
                  value: v,
                  label: t(($) => $.source.kind[v]),
                }))}
                value={sourceKind}
                onValueChange={(v) => {
                  setSourceKind(v as string);
                  // The event catalog is per-scope; a stale cross-scope
                  // selection would be a 400 route_invalid, so reset it.
                  setSelectedEvents([]);
                }}
                // The scope never changes through an edit (server-enforced).
                disabled={currentRoute != null}
              >
                <SelectTrigger className="w-full" aria-label={t(($) => $.source_editor.kind)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEAM_KINDS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(($) => $.source.kind[v])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-caption text-muted-foreground">
                {sourceKind === "comment"
                  ? t(($) => $.source_editor.kind_comment_hint)
                  : t(($) => $.source_editor.kind_activity_hint)}
              </p>
            </div>
          )}

          {!isTeam && (
            <Alert>
              <AlertDescription>
                {t(($) => $.source_editor.target_self_hint)}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <label className="text-caption text-muted-foreground">
              {t(($) => $.editor.bot)}
            </label>
            <Select
              items={activeInstallations.map((inst) => ({
                value: inst.id,
                label: getActorName("agent", inst.agent_id),
              }))}
              value={installationId}
              onValueChange={(v) => setInstallationId(v as string)}
            >
              <SelectTrigger className="w-full" aria-label={t(($) => $.editor.bot)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activeInstallations.map((inst) => (
                  <SelectItem key={inst.id} value={inst.id}>
                    {getActorName("agent", inst.agent_id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isTeam && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.source_editor.project)}
              </label>
              <Select
                items={[
                  { value: "", label: t(($) => $.source_editor.project_workspace) },
                  ...(projects ?? []).map((p) => ({ value: p.id, label: p.title })),
                ]}
                value={projectId}
                onValueChange={(v) => setProjectId(v as string)}
              >
                <SelectTrigger className="w-full" aria-label={t(($) => $.source_editor.project)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t(($) => $.source_editor.project_workspace)}</SelectItem>
                  {(projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-caption text-muted-foreground">
                {t(($) => $.source_editor.project_hint)}
              </p>
            </div>
          )}

          {isTeam && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.editor.target)}
              </label>
              <Select
                items={TEAM_TARGET_TYPES.map((v) => ({
                  value: v,
                  label: t(($) => $.target_type[v]),
                }))}
                value={targetType}
                onValueChange={(v) => setTargetType(v as MessageTargetType)}
              >
                <SelectTrigger className="w-full" aria-label={t(($) => $.editor.target)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEAM_TARGET_TYPES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(($) => $.target_type[v])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isExternal && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.editor.chat_id)}
              </label>
              <Input
                value={targetChatId}
                onChange={(e) => setTargetChatId(e.target.value)}
                placeholder={t(($) => $.editor.chat_id_placeholder)}
                className="font-mono"
              />
            </div>
          )}

          {isExternal && targetType === "topic" && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.editor.message_id)}
              </label>
              <Input
                value={targetMessageId}
                onChange={(e) => setTargetMessageId(e.target.value)}
                placeholder={t(($) => $.editor.message_id_placeholder)}
                className="font-mono"
              />
              <p className="text-caption text-muted-foreground">
                {t(($) => $.editor.message_id_hint)}
              </p>
            </div>
          )}

          {willApprove && (
            <Alert>
              <AlertDescription>
                {t(($) => $.source_editor.approval_admin)}
              </AlertDescription>
            </Alert>
          )}

          <fieldset className="space-y-1.5">
            <legend className="text-caption text-muted-foreground">
              {t(($) => $.source_editor.events)}
            </legend>
            {catalogError ? (
              <Alert variant="destructive">
                <AlertDescription className="flex items-center justify-between gap-2">
                  <span>{t(($) => $.source_editor.catalog_load_failed)}</span>
                  {onCatalogRetry && (
                    <Button size="sm" variant="outline" onClick={onCatalogRetry}>
                      {t(($) => $.editor.retry_reload)}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            ) : eventOptions.length === 0 ? (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.source_editor.events_hint)}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {eventOptions.map((opt) => {
                  const label = opt.i18nKey
                    ? isTeam
                      ? t(($) => $.team_event[opt.i18nKey as TeamEventKey])
                      : t(($) => $.event[opt.i18nKey as PersonalEventTypeKey])
                    : opt.fallback;
                  return (
                    <label
                      key={opt.value}
                      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-body"
                    >
                      <Checkbox
                        checked={selectedEvents.includes(opt.value)}
                        onCheckedChange={(checked) => toggleEvent(opt.value, checked === true)}
                      />
                      <span className="truncate">{label}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-caption text-muted-foreground">
              {t(($) => $.source_editor.events_hint)}
            </p>
          </fieldset>

          {currentRoute == null ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-caption text-muted-foreground">
                  {t(($) => $.editor.enabled)}
                </label>
                <Switch
                  size="sm"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label={t(($) => $.editor.enabled)}
                />
              </div>
              <p className="text-caption text-muted-foreground">
                {t(($) => $.source_editor.enable_hint)}
              </p>
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.source_editor.boundary_hint)}
            </p>
          )}

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{errorMessage}</span>
                {conflict === "reload_failed" && currentRoute && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => reloadAfterConflict(currentRoute.id)}
                  >
                    {t(($) => $.editor.retry_reload)}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t(($) => $.editor.cancel)}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!valid || saving || saveBlockedByConflict || saveBlockedByCatalog}
            >
              {saving
                ? t(($) => $.editor.saving)
                : willApprove
                  ? t(($) => $.editor.save_approve)
                  : t(($) => $.editor.save)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
