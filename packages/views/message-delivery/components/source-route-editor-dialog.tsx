"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  messageSourceKeys,
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
  SaveMessageSourceRouteRequest,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Switch } from "@multica/ui/components/ui/switch";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { toast } from "sonner";
import { useT } from "../../i18n";
import {
  isSourceTargetApproved,
  personalEventTypeKey,
  teamEventKey,
  type PersonalEventTypeKey,
  type TeamEventKey,
} from "../copy";
import {
  RouteEditorActions,
  RouteEditorDialogFrame,
  RouteEditorError,
  RouteSelectField,
  RouteInstallationField,
  RouteTargetFields,
  routeSubmissionState,
  useRouteConflict,
  useRouteTarget,
} from "./route-editor-common";


/**
 * React Query notifies useQuery observers one tick AFTER a failed read lands
 * in the cache; a write block must not have that gap. This mirrors the routes
 * query's error state synchronously from the query cache, so a failed
 * background refresh blocks saving the moment it is recorded — the
 * observer-driven `routesRefreshFailed` prop follows for the visible note.
 */
function useRoutesErrorSync(wsId: string, sourceKind?: string): boolean {
  const qc = useQueryClient();
  const queryKey = messageSourceKeys.routes(wsId, sourceKind);
  const [syncError, setSyncError] = useState<boolean>(
    () => qc.getQueryState?.(queryKey)?.status === "error",
  );
  useEffect(() => {
    const cache = qc.getQueryCache?.();
    if (!cache) return;
    return cache.subscribe((event) => {
      if (event.type === "updated" || event.type === "removed" || event.type === "added") {
        setSyncError(
          qc.getQueryState?.(messageSourceKeys.routes(wsId, sourceKind))?.status === "error",
        );
      }
    });
  }, [qc, wsId, sourceKind]);
  return syncError;
}

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
  routesRefreshFailed = false,
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
  /** True when the routes list's BACKGROUND refresh failed with retained
   * data (initial-load failures never reach the editor — the section keeps
   * its full error state instead). The open draft is preserved, but saving
   * is blocked until the list reads successfully again: the revision and
   * sibling-state the save builds on are not confirmed current. */
  routesRefreshFailed?: boolean;
}) {
  const { t } = useT("message-delivery");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const createRoute = useCreateMessageSourceRoute();
  const updateRoute = useUpdateMessageSourceRoute();
  const approveTarget = useApproveMessageSourceTarget();

  const target = useRouteTarget(
    route,
    mode === "personal" ? "member" : "group",
    installations,
  );
  const { installationId, targetType } = target;
  const [sourceKind, setSourceKind] = useState<string>(
    route?.source_kind ?? (mode === "personal" ? "inbox" : "activity"),
  );
  const [projectId, setProjectId] = useState<string>(route?.project_id ?? "");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(route?.event_types ?? []);
  // The unfiltered list contains the acting member's inbox rules and, for
  // owners/admins, the team rules. Adopt every route-specific field on 409.
  const { currentRoute, conflict, setConflict, reloadAfterConflict } = useRouteConflict(
    route,
    // fetchQuery returns the raw envelope (select is observer-only).
    () => qc.fetchQuery(messageSourceRoutesOptions(wsId)),
    (found) => {
      setSourceKind(found.source_kind);
      target.adopt(found);
      setProjectId(found.project_id ?? "");
      setSelectedEvents(found.event_types);
    },
  );
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [error, setError] = useState<unknown>(null);

  const isTeam = mode === "team";
  const isExternal = isTeam && (targetType === "group" || targetType === "topic");

  const typedKey = target.typedKey;
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

  const valid = installationId !== "" && (!isTeam || target.targetValid);

  const { saving, saveBlockedByConflict } = routeSubmissionState(
    conflict,
    createRoute.isPending,
    updateRoute.isPending,
    approveTarget.isPending,
  );
  // Without the catalog the event filter cannot be expressed: an empty
  // event_types means "forward everything" and must never be submitted by
  // default. Block saving while the catalog is missing (loading or failed)
  // AND when a refresh failed with retained (now unverifiable) data — the
  // error state means the options on screen are not confirmed current.
  const saveBlockedByCatalog = catalog == null || catalogError;
  // Same honesty for the routes list the save builds on (revision for
  // updates, sibling state): a failed background refresh pauses saving
  // without touching the open draft. The synchronous cache mirror closes the
  // observer-notification gap, so the block is in force the moment the
  // failed read is recorded, not one render later.
  const routesErrorSync = useRoutesErrorSync(wsId, mode === "personal" ? "inbox" : undefined);
  const routesFailed = routesRefreshFailed || routesErrorSync;
  const saveBlocked =
    saveBlockedByConflict || saveBlockedByCatalog || routesFailed;

  const toggleEvent = (value: string, checked: boolean) => {
    setSelectedEvents((prev) =>
      checked ? [...prev, value] : prev.filter((v) => v !== value),
    );
  };

  const handleSave = async () => {
    // The button is disabled in these states; guard the submit itself too so
    // a programmatic/keyboard path can never write past them. The routes
    // error state is re-read straight from the cache — the freshest possible
    // answer at click time.
    if (saveBlocked || saving || !valid) return;
    const routesStatus = qc.getQueryState?.(
      messageSourceKeys.routes(wsId, mode === "personal" ? "inbox" : undefined),
    )?.status;
    if (routesStatus === "error") return;
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
            ...target.payload,
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
          ...target.approvalPayload,
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

  const title = currentRoute
    ? isTeam
      ? t(($) => $.source_editor.title_edit_team)
      : t(($) => $.source_editor.title_edit_personal)
    : isTeam
      ? t(($) => $.source_editor.title_add_team)
      : t(($) => $.source_editor.title_add_personal);

  return (
    <RouteEditorDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      contentClassName="sm:max-w-lg max-h-[85vh] overflow-y-auto"
    >
      {isTeam && (
        <RouteSelectField
          label={t(($) => $.source_editor.kind)}
          options={TEAM_KINDS.map((v) => ({ value: v, label: t(($) => $.source.kind[v]) }))}
          value={sourceKind}
          onChange={(v) => {
            setSourceKind(v);
            // The event catalog is per-scope; a stale cross-scope
            // selection would be a 400 route_invalid, so reset it.
            setSelectedEvents([]);
          }}
          // The scope never changes through an edit (server-enforced).
          disabled={currentRoute != null}
          hint={
            sourceKind === "comment"
              ? t(($) => $.source_editor.kind_comment_hint)
              : t(($) => $.source_editor.kind_activity_hint)
          }
        />
      )}

      {!isTeam && (
        <Alert>
          <AlertDescription>{t(($) => $.source_editor.target_self_hint)}</AlertDescription>
        </Alert>
      )}

      <RouteInstallationField target={target} />

      {isTeam && (
        <RouteSelectField
          label={t(($) => $.source_editor.project)}
          options={[
            { value: "", label: t(($) => $.source_editor.project_workspace) },
            ...(projects ?? []).map((p) => ({ value: p.id, label: p.title })),
          ]}
          value={projectId}
          onChange={setProjectId}
          hint={t(($) => $.source_editor.project_hint)}
        />
      )}

          <RouteTargetFields
            target={target}
            targetTypes={isTeam ? TEAM_TARGET_TYPES : undefined}
            saving={saving}
            external={isExternal}
          />

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

          {routesFailed && (
            <Alert>
              <AlertDescription>
                {t(($) => $.source_editor.routes_refresh_failed)}
              </AlertDescription>
            </Alert>
          )}

          <RouteEditorError
            error={error}
            conflict={conflict}
            onRetry={currentRoute ? () => reloadAfterConflict(currentRoute.id) : undefined}
          />
          <RouteEditorActions
            saving={saving}
            willApprove={willApprove}
            disabled={!valid || saving || saveBlocked}
            onSave={handleSave}
            onCancel={() => onOpenChange(false)}
          />
    </RouteEditorDialogFrame>
  );
}
