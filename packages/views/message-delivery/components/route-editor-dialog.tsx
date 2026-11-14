"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  messageRoutesOptions,
  useApproveMessageTarget,
  useCreateMessageRoute,
  useUpdateMessageRoute,
} from "@multica/core/message-delivery";
import { useWorkspaceId } from "@multica/core/hooks";
import { errorCode } from "@multica/core/api";
import type {
  MessageApprovedTarget,
  MessageContentMode,
  MessageRoute,
  MessageRouteCondition,
  SaveMessageRouteRequest,
} from "@multica/core/types";
import { Switch } from "@multica/ui/components/ui/switch";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { toast } from "sonner";
import { useT } from "../../i18n";
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

const TARGET_TYPES = ["member", "group", "topic"] as const;
const CONDITIONS = ["success", "failure", "all"] as const;
const CONTENT_MODES = ["summary", "with_output"] as const;

/**
 * Editor for one push route. Kept separate from the automation's own dialog
 * on purpose (OL-23): the route save is its own revision-guarded call, and a
 * failed save must never surface as "push enabled".
 *
 * Group/topic targets need an active workspace-admin approval scoped to
 * (workspace, automation, bot, target). Admins approve inline — save runs the
 * approval first (which verifies the target against the live platform) and
 * then saves the route. Collaborators see the pending-approval hint and the
 * server's route_target_not_approved error if they try to save anyway.
 */
export function MessageRouteEditorDialog({
  open,
  onOpenChange,
  autopilotId,
  route,
  executionMode,
  installations,
  members,
  approvals,
  isAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autopilotId: string;
  /** null → create mode. */
  route: MessageRoute | null;
  executionMode: string;
  installations: { id: string; agent_id: string; status: string; region?: string | null }[];
  members: { user_id: string; name: string; email: string }[];
  approvals: MessageApprovedTarget[];
  isAdmin: boolean;
}) {
  const { t } = useT("message-delivery");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const createRoute = useCreateMessageRoute();
  const updateRoute = useUpdateMessageRoute();
  const approveTarget = useApproveMessageTarget();
  const target = useRouteTarget(route, "member", installations);
  const { installationId, targetType } = target;
  const [conditions, setConditions] = useState<MessageRouteCondition>(
    route?.conditions ?? "success",
  );
  const [contentMode, setContentMode] = useState<MessageContentMode>(
    route?.content_mode ?? "summary",
  );
  // On a 409 the latest committed version is adopted here, including every
  // route-specific field, so the next save carries the newest revision.
  const { currentRoute, conflict, setConflict, reloadAfterConflict } = useRouteConflict(
    route,
    // fetchQuery returns the raw envelope (select is observer-only).
    () => qc.fetchQuery(messageRoutesOptions(wsId, autopilotId)),
    (found) => {
      target.adopt(found);
      setConditions(found.conditions);
      setContentMode(found.content_mode);
    },
  );
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [error, setError] = useState<unknown>(null);

  const isExternal = targetType === "group" || targetType === "topic";
  const typedKey = target.typedKey;
  const isApproved = useMemo(
    () =>
      approvals.some(
        (a) =>
          a.installation_id === installationId &&
          a.target_key === typedKey &&
          a.revoked_at == null,
      ),
    [approvals, installationId, typedKey],
  );
  // An admin saving an unapproved external target approves it in the same
  // submit; the button label says so. Collaborators get the server error.
  const willApprove = isExternal && isAdmin && !isApproved;

  const valid = installationId !== "" && target.targetValid;

  const { saving, saveBlockedByConflict } = routeSubmissionState(
    conflict,
    createRoute.isPending,
    updateRoute.isPending,
    approveTarget.isPending,
  );

  const handleSave = async () => {
    setError(null);
    // A new save ends the previous round's "adopted latest" notice — the
    // result of THIS attempt (success or its own error) is what must show.
    if (conflict === "adopted") setConflict(null);
    const payload: SaveMessageRouteRequest = {
      installation_id: installationId,
      target_type: targetType,
      conditions,
      content_mode: contentMode,
      ...target.payload,
    };
    try {
      if (willApprove) {
        await approveTarget.mutateAsync({
          autopilotId,
          installation_id: installationId,
          target_type: targetType,
          ...target.approvalPayload,
        });
      }
      if (currentRoute) {
        await updateRoute.mutateAsync({
          autopilotId,
          routeId: currentRoute.id,
          ...payload,
          expected_revision: currentRoute.revision,
        });
      } else {
        await createRoute.mutateAsync({ autopilotId, ...payload, enabled });
      }
      toast.success(t(($) => $.routes.toast_saved));
      onOpenChange(false);
    } catch (e) {
      // Stays inside the dialog — a failed save must not look like a saved,
      // enabled push anywhere else on the page.
      if (errorCode(e) === "route_revision_conflict" && currentRoute) {
        await reloadAfterConflict(currentRoute.id);
      }
      setError(e);
    }
  };

  return (
    <RouteEditorDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title={currentRoute ? t(($) => $.editor.title_edit) : t(($) => $.editor.title_add)}
      contentClassName="max-w-lg max-h-[85vh] overflow-y-auto"
    >
      <RouteInstallationField target={target} />
      <RouteTargetFields
        target={target}
        targetTypes={TARGET_TYPES}
        members={members}
        saving={saving}
      />

      {isExternal && !isApproved && (
        <Alert>
          <AlertDescription>
            {isAdmin
              ? t(($) => $.editor.approval_admin)
              : t(($) => $.editor.approval_member)}
          </AlertDescription>
        </Alert>
      )}

      <RouteSelectField
        label={t(($) => $.editor.when)}
        options={CONDITIONS.map((v) => ({ value: v, label: t(($) => $.condition[v]) }))}
        value={conditions}
        onChange={(v) => setConditions(v as MessageRouteCondition)}
      />

      <RouteSelectField
        label={t(($) => $.editor.content)}
        options={CONTENT_MODES.map((v) => ({ value: v, label: t(($) => $.content_mode[v]) }))}
        value={contentMode}
        onChange={(v) => setContentMode(v as MessageContentMode)}
        disabled={executionMode === "create_issue"}
        hint={
          executionMode === "create_issue"
            ? t(($) => $.content_mode.hint_create_issue)
            : t(($) => $.content_mode.hint_empty_output)
        }
      />

      {currentRoute == null && (
        <div className="flex items-center justify-between">
          <label className="text-caption text-muted-foreground">
            {t(($) => $.editor.enabled)}
          </label>
          <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      )}

      <RouteEditorError
        error={error}
        conflict={conflict}
        onRetry={currentRoute ? () => reloadAfterConflict(currentRoute.id) : undefined}
      />
      <RouteEditorActions
        saving={saving}
        willApprove={willApprove}
        disabled={!valid || saving || saveBlockedByConflict}
        onSave={handleSave}
        onCancel={() => onOpenChange(false)}
      />
    </RouteEditorDialogFrame>
  );
}
