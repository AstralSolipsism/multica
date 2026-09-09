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
  MessageTargetType,
  SaveMessageRouteRequest,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
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
import { messageDeliveryErrorKey, messageTargetKey } from "../copy";

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
  const { getActorName } = useActorName();
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const createRoute = useCreateMessageRoute();
  const updateRoute = useUpdateMessageRoute();
  const approveTarget = useApproveMessageTarget();
  // The route being edited. On a 409 the latest committed version is
  // refetched and adopted HERE, so the next save carries the newest
  // expected_revision — the conflict copy's promise is real, not advice.
  const [currentRoute, setCurrentRoute] = useState<MessageRoute | null>(route);

  const activeInstallations = installations.filter((inst) => inst.status === "active");

  const [installationId, setInstallationId] = useState(
    route?.installation_id ?? activeInstallations[0]?.id ?? "",
  );
  const [targetType, setTargetType] = useState<MessageTargetType>(
    route?.target_type ?? "member",
  );
  const [targetUserId, setTargetUserId] = useState(route?.target_user_id ?? "");
  const [targetChatId, setTargetChatId] = useState(route?.target_chat_id ?? "");
  const [targetMessageId, setTargetMessageId] = useState(route?.target_message_id ?? "");
  const [conditions, setConditions] = useState<MessageRouteCondition>(
    route?.conditions ?? "success",
  );
  const [contentMode, setContentMode] = useState<MessageContentMode>(
    route?.content_mode ?? "summary",
  );
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [error, setError] = useState<unknown>(null);

  const isExternal = targetType === "group" || targetType === "topic";
  const typedKey = useMemo(
    () =>
      messageTargetKey(targetType, {
        userId: targetUserId.trim(),
        chatId: targetChatId.trim(),
        messageId: targetMessageId.trim(),
      }),
    [targetType, targetUserId, targetChatId, targetMessageId],
  );
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

  const valid =
    installationId !== "" &&
    (targetType === "member"
      ? targetUserId.trim() !== ""
      : targetType === "group"
        ? targetChatId.trim() !== ""
        : targetChatId.trim() !== "" && targetMessageId.trim() !== "");

  const saving =
    createRoute.isPending || updateRoute.isPending || approveTarget.isPending;

  const handleSave = async () => {
    setError(null);
    const payload: SaveMessageRouteRequest = {
      installation_id: installationId,
      target_type: targetType,
      conditions,
      content_mode: contentMode,
      ...(targetType === "member"
        ? { target_user_id: targetUserId.trim() }
        : {
            target_chat_id: targetChatId.trim(),
            ...(targetType === "topic"
              ? { target_message_id: targetMessageId.trim() }
              : {}),
          }),
    };
    try {
      if (willApprove) {
        await approveTarget.mutateAsync({
          autopilotId,
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
        try {
          // fetchQuery returns the raw envelope (select is observer-only).
          const fresh = await qc.fetchQuery(messageRoutesOptions(wsId, autopilotId));
          const found = fresh.routes.find((r: MessageRoute) => r.id === currentRoute.id);
          if (found) setCurrentRoute(found);
        } catch {
          // The refetch failed too; the conflict alert still explains the
          // situation and the list below is already fresh from invalidation.
        }
      }
      setError(e);
    }
  };

  const errCode = errorCode(error);
  const errorMessage =
    error == null
      ? null
      : errCode === "route_revision_conflict"
        ? t(($) => $.editor.conflict)
        : t(($) => $.error[messageDeliveryErrorKey(errCode)]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogTitle>
          {currentRoute ? t(($) => $.editor.title_edit) : t(($) => $.editor.title_add)}
        </DialogTitle>
        <div className="space-y-4 pt-1">
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

          <div className="space-y-1.5">
            <label className="text-caption text-muted-foreground">
              {t(($) => $.editor.target)}
            </label>
            <Select
              items={TARGET_TYPES.map((v) => ({ value: v, label: t(($) => $.target_type[v]) }))}
              value={targetType}
              onValueChange={(v) => setTargetType(v as MessageTargetType)}
            >
              <SelectTrigger className="w-full" aria-label={t(($) => $.editor.target)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARGET_TYPES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(($) => $.target_type[v])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {targetType === "member" && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.editor.member)}
              </label>
              <Select
                items={members.map((m) => ({
                  value: m.user_id,
                  label: m.name || m.email,
                }))}
                value={targetUserId}
                onValueChange={(v) => setTargetUserId(v as string)}
              >
                <SelectTrigger className="w-full" aria-label={t(($) => $.editor.member)}>
                  <SelectValue placeholder={t(($) => $.editor.member_placeholder)} />
                </SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.name || m.email}
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

          {targetType === "topic" && (
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

          {isExternal && !isApproved && (
            <Alert>
              <AlertDescription>
                {isAdmin
                  ? t(($) => $.editor.approval_admin)
                  : t(($) => $.editor.approval_member)}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <label className="text-caption text-muted-foreground">
              {t(($) => $.editor.when)}
            </label>
            <Select
              items={CONDITIONS.map((v) => ({ value: v, label: t(($) => $.condition[v]) }))}
              value={conditions}
              onValueChange={(v) => setConditions(v as MessageRouteCondition)}
            >
              <SelectTrigger className="w-full" aria-label={t(($) => $.editor.when)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITIONS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(($) => $.condition[v])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-caption text-muted-foreground">
              {t(($) => $.editor.content)}
            </label>
            <Select
              items={CONTENT_MODES.map((v) => ({ value: v, label: t(($) => $.content_mode[v]) }))}
              value={contentMode}
              onValueChange={(v) => setContentMode(v as MessageContentMode)}
              disabled={executionMode === "create_issue"}
            >
              <SelectTrigger className="w-full" aria-label={t(($) => $.editor.content)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_MODES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {t(($) => $.content_mode[v])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">
              {executionMode === "create_issue"
                ? t(($) => $.content_mode.hint_create_issue)
                : t(($) => $.content_mode.hint_empty_output)}
            </p>
          </div>

          {currentRoute == null && (
            <div className="flex items-center justify-between">
              <label className="text-caption text-muted-foreground">
                {t(($) => $.editor.enabled)}
              </label>
              <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          )}

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t(($) => $.editor.cancel)}
            </Button>
            <Button onClick={handleSave} disabled={!valid || saving}>
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
