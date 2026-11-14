"use client";

import { useMemo, useState, type ReactNode } from "react";
import { errorCode } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useActorName } from "@multica/core/workspace/hooks";
import type { MessageTargetType } from "@multica/core/types";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";
import { LarkAnchorPicker, LarkChatPicker } from "../../lark";
import { messageDeliveryErrorKey, messageTargetKey } from "../copy";
import { anchorAfterChatChange, anchorAfterMessageEdit } from "../target-selection";

export type RouteConflict = "reloading" | "adopted" | "reload_failed" | "gone" | null;

type RouteTargetRecord = {
  installation_id: string;
  target_type: MessageTargetType;
  target_user_id?: string | null;
  target_chat_id?: string | null;
  target_message_id?: string | null;
  target_thread_id?: string | null;
};

type Installation = {
  id: string;
  agent_id: string;
  status: string;
  region?: string | null;
};

export interface RouteTargetState {
  activeInstallations: Installation[];
  installationId: string;
  targetType: MessageTargetType;
  targetUserId: string;
  targetChatId: string;
  targetMessageId: string;
  targetThreadId: string;
  targetValid: boolean;
  typedKey: string;
  payload: {
    target_user_id?: string;
    target_chat_id?: string;
    target_message_id?: string;
    target_thread_id?: string;
  };
  approvalPayload: { target_chat_id: string; target_message_id?: string };
  targetChatName: string;
  targetAnchorSummary: string;
  setInstallationId: (value: string) => void;
  setTargetType: (value: MessageTargetType) => void;
  setTargetUserId: (value: string) => void;
  setTargetMessageId: (value: string) => void;
  setTargetAnchorSummary: (value: string) => void;
  setTargetThreadId: (value: string) => void;
  applyTargetChatId: (nextChatId: string, name?: string) => void;
  applyTargetMessageId: (nextMessageId: string) => void;
  adopt: (found: RouteTargetRecord) => void;
}

export function useRouteTarget(
  route: RouteTargetRecord | null,
  defaultTargetType: MessageTargetType,
  installations: Installation[],
): RouteTargetState {
  const activeInstallations = installations.filter((inst) => inst.status === "active");
  const [installationId, setInstallationId] = useState(
    route?.installation_id ?? activeInstallations[0]?.id ?? "",
  );
  const [targetType, setTargetType] = useState<MessageTargetType>(
    route?.target_type ?? defaultTargetType,
  );
  const [targetUserId, setTargetUserId] = useState(route?.target_user_id ?? "");
  const [targetChatId, setTargetChatId] = useState(route?.target_chat_id ?? "");
  const [targetMessageId, setTargetMessageId] = useState(route?.target_message_id ?? "");
  // Display-only snapshots; persisted identity stays the raw IDs.
  const [targetChatName, setTargetChatName] = useState("");
  const [targetAnchorSummary, setTargetAnchorSummary] = useState("");
  const [targetThreadId, setTargetThreadId] = useState(route?.target_thread_id ?? "");

  // The anchor triple only survives edits that leave its parent untouched.
  const applyTargetChatId = (nextChatId: string, name = "") => {
    const anchor = anchorAfterChatChange(targetChatId, nextChatId, {
      messageId: targetMessageId,
      threadId: targetThreadId,
      summary: targetAnchorSummary,
    });
    setTargetChatId(nextChatId);
    setTargetChatName(name);
    setTargetMessageId(anchor.messageId);
    setTargetThreadId(anchor.threadId);
    setTargetAnchorSummary(anchor.summary);
  };
  const applyTargetMessageId = (nextMessageId: string) => {
    const anchor = anchorAfterMessageEdit(targetMessageId, nextMessageId, {
      messageId: targetMessageId,
      threadId: targetThreadId,
      summary: targetAnchorSummary,
    });
    setTargetMessageId(anchor.messageId);
    setTargetThreadId(anchor.threadId);
    setTargetAnchorSummary(anchor.summary);
  };

  const adopt = (found: RouteTargetRecord) => {
    setInstallationId(found.installation_id);
    setTargetType(found.target_type);
    setTargetUserId(found.target_user_id ?? "");
    setTargetChatId(found.target_chat_id ?? "");
    setTargetMessageId(found.target_message_id ?? "");
    setTargetThreadId(found.target_thread_id ?? "");
    setTargetChatName("");
    setTargetAnchorSummary("");
  };

  const targetValid =
    targetType === "member"
      ? targetUserId.trim() !== ""
      : targetType === "group"
        ? targetChatId.trim() !== ""
        : targetChatId.trim() !== "" && targetMessageId.trim() !== "";

  const typedKey = useMemo(
    () =>
      messageTargetKey(targetType, {
        userId: targetUserId.trim(),
        chatId: targetChatId.trim(),
        messageId: targetMessageId.trim(),
      }),
    [targetType, targetUserId, targetChatId, targetMessageId],
  );
  const payload: RouteTargetState["payload"] =
    targetType === "member"
      ? { target_user_id: targetUserId.trim() }
      : {
          target_chat_id: targetChatId.trim(),
          ...(targetType === "topic"
            ? {
                target_message_id: targetMessageId.trim(),
                // Manual ID entry (discovery fallback) never carries a thread.
                ...(targetThreadId.trim() !== ""
                  ? { target_thread_id: targetThreadId.trim() }
                  : {}),
              }
            : {}),
        };
  const approvalPayload: RouteTargetState["approvalPayload"] = {
    target_chat_id: targetChatId.trim(),
    ...(targetType === "topic" ? { target_message_id: targetMessageId.trim() } : {}),
  };

  return {
    activeInstallations,
    installationId,
    targetType,
    targetUserId,
    targetChatId,
    targetMessageId,
    targetThreadId,
    targetValid,
    typedKey,
    payload,
    approvalPayload,
    setInstallationId,
    setTargetType,
    setTargetUserId,
    applyTargetChatId,
    applyTargetMessageId,
    adopt,
    targetChatName,
    targetAnchorSummary,
    setTargetMessageId,
    setTargetAnchorSummary,
    setTargetThreadId,
  };
}

export function useRouteConflict<TRoute extends { id: string }>(
  route: TRoute | null,
  loadRoutes: () => Promise<{ routes: TRoute[] }>,
  adopt: (route: TRoute) => void,
) {
  const [currentRoute, setCurrentRoute] = useState<TRoute | null>(route);
  const [conflict, setConflict] = useState<RouteConflict>(null);

  // Adopt the other writer's committed version in full; any other outcome
  // leaves the stale draft blocked behind an honest state.
  const reloadAfterConflict = async (routeId: string) => {
    setConflict("reloading");
    try {
      const fresh = await loadRoutes();
      const found = fresh.routes.find((r) => r.id === routeId);
      if (!found) {
        setConflict("gone");
        return;
      }
      setCurrentRoute(found);
      adopt(found);
      setConflict("adopted");
    } catch {
      setConflict("reload_failed");
    }
  };

  return { currentRoute, conflict, setConflict, reloadAfterConflict };
}

export function routeSubmissionState(conflict: RouteConflict, ...pending: boolean[]) {
  return {
    saving: pending.some(Boolean) || conflict === "reloading",
    saveBlockedByConflict:
      conflict === "reloading" || conflict === "reload_failed" || conflict === "gone",
  };
}

export function RouteEditorDialogFrame({
  open,
  onOpenChange,
  title,
  contentClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  contentClassName: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={contentClassName}>
        <DialogTitle>{title}</DialogTitle>
        <div className="space-y-4 pt-1">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function RouteField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-caption text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function RouteSelectField({
  label,
  options,
  value,
  onChange,
  disabled,
  hint,
  placeholder,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <RouteField label={label} hint={hint}>
      <Select
        items={options}
        value={value}
        onValueChange={(v) => onChange(v as string)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </RouteField>
  );
}

export function RouteInstallationField({
  target,
}: {
  target: RouteTargetState;
}) {
  const { t } = useT("message-delivery");
  const { getActorName } = useActorName();
  const label = t(($) => $.editor.bot);
  return (
    <RouteSelectField
      label={label}
      options={target.activeInstallations.map((inst) => ({
        value: inst.id,
        label: getActorName("agent", inst.agent_id),
      }))}
      value={target.installationId}
      onChange={target.setInstallationId}
    />
  );
}

export function RouteTargetFields({
  target,
  targetTypes,
  members,
  saving,
  external,
}: {
  target: RouteTargetState;
  targetTypes?: readonly MessageTargetType[];
  members?: { user_id: string; name: string; email: string }[];
  saving: boolean;
  external?: boolean;
}) {
  const { t } = useT("message-delivery");
  const wsId = useWorkspaceId();
  const isExternal =
    external ?? (target.targetType === "group" || target.targetType === "topic");
  return (
    <>
      {targetTypes && (
        <RouteSelectField
          label={t(($) => $.editor.target)}
          options={targetTypes.map((v) => ({
            value: v,
            label: t(($) => $.target_type[v as "member" | "group" | "topic"]),
          }))}
          value={target.targetType}
          onChange={(v) => target.setTargetType(v as MessageTargetType)}
        />
      )}

      {members && target.targetType === "member" && (
        <RouteSelectField
          label={t(($) => $.editor.member)}
          options={members.map((m) => ({ value: m.user_id, label: m.name || m.email }))}
          value={target.targetUserId}
          onChange={target.setTargetUserId}
          placeholder={t(($) => $.editor.member_placeholder)}
        />
      )}

      {isExternal && (
        <RouteField label={t(($) => $.editor.group)}>
          <LarkChatPicker
            wsId={wsId}
            installationId={target.installationId}
            value={
              target.targetChatId.trim() !== ""
                ? { chatId: target.targetChatId.trim(), name: target.targetChatName }
                : null
            }
            onChange={(sel) => target.applyTargetChatId(sel?.chatId ?? "", sel?.name ?? "")}
            disabled={saving}
            fallback={
              <Input
                value={target.targetChatId}
                onChange={(e) => target.applyTargetChatId(e.target.value)}
                placeholder={t(($) => $.editor.chat_id_placeholder)}
                className="font-mono"
                aria-label={t(($) => $.editor.chat_id)}
              />
            }
          />
        </RouteField>
      )}

      {isExternal && target.targetType === "topic" && (
        <RouteField label={t(($) => $.editor.anchor)}>
          <LarkAnchorPicker
            wsId={wsId}
            installationId={target.installationId}
            chatId={target.targetChatId.trim()}
            value={
              target.targetMessageId.trim() !== ""
                ? {
                    messageId: target.targetMessageId.trim(),
                    summary: target.targetAnchorSummary,
                  }
                : null
            }
            onChange={(sel) => {
              target.setTargetMessageId(sel?.messageId ?? "");
              target.setTargetAnchorSummary(sel?.summary ?? "");
              target.setTargetThreadId(sel?.threadId ?? "");
            }}
            disabled={saving}
            fallback={
              <>
                <Input
                  value={target.targetMessageId}
                  onChange={(e) => target.applyTargetMessageId(e.target.value)}
                  placeholder={t(($) => $.editor.message_id_placeholder)}
                  className="font-mono"
                  aria-label={t(($) => $.editor.message_id)}
                />
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.editor.message_id_hint)}
                </p>
              </>
            }
          />
        </RouteField>
      )}
    </>
  );
}

export function RouteEditorError({
  error,
  conflict,
  onRetry,
}: {
  error: unknown;
  conflict: RouteConflict;
  onRetry?: () => void;
}) {
  const { t } = useT("message-delivery");
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
  if (!errorMessage) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-center justify-between gap-2">
        <span>{errorMessage}</span>
        {conflict === "reload_failed" && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t(($) => $.editor.retry_reload)}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function RouteEditorActions({
  saving,
  willApprove,
  disabled,
  onSave,
  onCancel,
}: {
  saving: boolean;
  willApprove: boolean;
  disabled: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useT("message-delivery");
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button variant="outline" onClick={onCancel} disabled={saving}>
        {t(($) => $.editor.cancel)}
      </Button>
      <Button onClick={onSave} disabled={disabled}>
        {saving
          ? t(($) => $.editor.saving)
          : willApprove
            ? t(($) => $.editor.save_approve)
            : t(($) => $.editor.save)}
      </Button>
    </div>
  );
}
