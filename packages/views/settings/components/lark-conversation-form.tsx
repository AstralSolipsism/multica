"use client";

import { useEffect, useRef, useState } from "react";
import { useSetLarkConversation } from "@multica/core/lark";
import type { LarkConversationGrant, LarkInstallation } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { LarkChatMultiSelect, LarkPrivateChatSelect, type LarkChatSelection } from "../../lark";
import { mergeConversationDraft, sameConversationChats } from "../../lark/discovery";

/** Server-side conversation grant cap (scope must be workspace; at most 50
 * chats — server/internal/handler/labrastro_conversation.go). The picker
 * enforces it live so the user sees the limit before the server rejects. */
const MAX_CONVERSATION_CHATS = 50;

/**
 * Conversation authorization for one bot installation: authorized GROUPS are
 * picked from the bot's joined-group list (LarkChatMultiSelect, OL-74) and
 * authorized PRIVATE chats are discovered from inbound messages and confirmed
 * by a human (LarkPrivateChatSelect, OL-76) instead of typed as raw oc_ IDs.
 * Both pickers keep the legacy textarea as fallback for servers without
 * discovery. Manual save/revoke, dedupe, the 50-chat cap and a failed save
 * keeping the draft are preserved.
 */
export function LarkConversationForm({ workspaceId, installation, disabled }: {
  workspaceId: string; installation: LarkInstallation; disabled: boolean;
}) {
  const { t } = useT("settings");
  // Two representations of the same group set: the picker edits the array;
  // the legacy textarea (fallback when discovery is unsupported) edits the
  // text. Both are kept in sync so save always derives from the array. The
  // direct-chat set uses the same pair (picker chips / fallback textarea).
  const [groups, setGroups] = useState<LarkChatSelection[]>(() =>
    installation.conversation?.chats
      .filter((c) => c.chat_type === "group")
      .map((c) => ({ chatId: c.chat_id, name: "" })) ?? []);
  const [groupsText, setGroupsText] = useState(() =>
    installation.conversation?.chats
      .filter((c) => c.chat_type === "group")
      .map((c) => c.chat_id)
      .join("\n") ?? "");
  const [directs, setDirects] = useState<LarkChatSelection[]>(() =>
    installation.conversation?.chats
      .filter((c) => c.chat_type === "p2p")
      .map((c) => ({ chatId: c.chat_id, name: "" })) ?? []);
  const [directsText, setDirectsText] = useState(() =>
    installation.conversation?.chats
      .filter((c) => c.chat_type === "p2p")
      .map((c) => c.chat_id)
      .join("\n") ?? "");
  const mutation = useSetLarkConversation(workspaceId, installation.id);
  const [saved, setSaved] = useState(false);
  // The candidate confirm's wait state, shared from the picker: confirm and
  // the full-list save/revoke are mutually exclusive writes — a stale-draft
  // PUT committed after a confirm would drop the freshly authorized chats,
  // and a late confirm response must not land while a PUT is in flight.
  const [confirmBusy, setConfirmBusy] = useState(false);
  const blocked = disabled || mutation.isPending || confirmBusy;

  // The authoritative saved grant the current draft derives from. When a
  // newer grant arrives — the confirm mutation's cache write, a WS-driven
  // invalidation, or the refetch after our own save — the draft re-baselines
  // to it and replays only explicit local edit intent (picks added / chips
  // removed since the baseline). This is what stops a stale full-list save
  // from dropping chats authorized elsewhere or resurrecting revoked ones.
  const baselineRef = useRef<LarkConversationGrant | null | undefined>(installation.conversation);
  useEffect(() => {
    const incoming = installation.conversation;
    // undefined = the field is absent (server drift): no authoritative value
    // to re-baseline against, keep the draft and the baseline.
    if (incoming === undefined || incoming === baselineRef.current) return;
    const baseline = baselineRef.current;
    baselineRef.current = incoming;
    if (sameConversationChats(incoming?.chats, baseline?.chats)) return;
    const draft = [
      ...groups.map((g) => ({ ...g, chat_type: "group" as const })),
      ...directs.map((d) => ({ ...d, chat_type: "p2p" as const })),
    ];
    const merged = mergeConversationDraft(baseline?.chats, incoming?.chats, draft);
    if (
      sameConversationChats(
        merged.map((m) => ({ chat_id: m.chatId, chat_type: m.chat_type })),
        draft.map((d) => ({ chat_id: d.chatId, chat_type: d.chat_type })),
      )
    ) {
      return;
    }
    const nextGroups = merged.filter((m) => m.chat_type === "group").map(({ chatId, name }) => ({ chatId, name }));
    const nextDirects = merged.filter((m) => m.chat_type === "p2p").map(({ chatId, name }) => ({ chatId, name }));
    setGroups(nextGroups);
    setGroupsText(nextGroups.map((g) => g.chatId).join("\n"));
    setDirects(nextDirects);
    setDirectsText(nextDirects.map((d) => d.chatId).join("\n"));
    setSaved(false);
  }, [installation.conversation, groups, directs]);

  const overLimit = groups.length + directs.length > MAX_CONVERSATION_CHATS;

  function applyGroups(next: LarkChatSelection[]) {
    // Dedupe by chat_id — a duplicate conversation is a 400 server-side.
    const seen = new Set<string>();
    const deduped = next.filter((g) => !seen.has(g.chatId) && seen.add(g.chatId));
    setGroups(deduped);
    setGroupsText(deduped.map((g) => g.chatId).join("\n"));
    setSaved(false);
  }

  function applyGroupsText(text: string) {
    setGroupsText(text);
    const seen = new Set<string>();
    setGroups(
      text.split(/\s+/).filter(Boolean)
        .filter((id) => !seen.has(id) && seen.add(id))
        .map((chatId) => ({ chatId, name: "" })),
    );
    setSaved(false);
  }

  function applyDirects(next: LarkChatSelection[]) {
    const seen = new Set<string>();
    const deduped = next.filter((d) => !seen.has(d.chatId) && seen.add(d.chatId));
    setDirects(deduped);
    setDirectsText(deduped.map((d) => d.chatId).join("\n"));
    setSaved(false);
  }

  function applyDirectsText(text: string) {
    setDirectsText(text);
    const seen = new Set<string>();
    setDirects(
      text.split(/\s+/).filter(Boolean)
        .filter((id) => !seen.has(id) && seen.add(id))
        .map((chatId) => ({ chatId, name: "" })),
    );
    setSaved(false);
  }

  async function save(revoke: boolean) {
    if (blocked) return;
    setSaved(false);
    const chats = revoke ? [] : [
      ...groups.map((g) => ({ chat_id: g.chatId, chat_type: "group" as const })),
      ...directs.map((d) => ({ chat_id: d.chatId, chat_type: "p2p" as const })),
    ];
    try {
      await mutation.mutateAsync(chats);
      if (revoke) { applyGroups([]); applyDirects([]); }
      setSaved(true);
    } catch { /* The mutation error stays visible with the draft intact. */ }
  }
  return <details className="mt-3 max-w-xl space-y-3 text-caption">
    <summary className="cursor-pointer font-medium">{t($ => $.lark.conversation_title)}</summary>
    <p className="text-muted-foreground">{t($ => $.lark.conversation_description)}</p>
    <div className="block space-y-1">
      <span>{t($ => $.lark.conversation_groups_label)}</span>
      <LarkChatMultiSelect
        wsId={workspaceId}
        installationId={installation.id}
        selected={groups}
        onChange={applyGroups}
        max={MAX_CONVERSATION_CHATS}
        otherCount={directs.length}
        disabled={blocked}
        fallback={
          <Textarea
            value={groupsText}
            onChange={e => applyGroupsText(e.target.value)}
            rows={2}
            disabled={mutation.isPending}
            aria-label={t($ => $.lark.conversation_groups)}
            placeholder={t($ => $.lark.conversation_groups)}
          />
        }
      />
    </div>
    <div className="block space-y-1">
      <span>{t($ => $.lark.conversation_directs_label)}</span>
      <LarkPrivateChatSelect
        wsId={workspaceId}
        installationId={installation.id}
        selected={directs}
        onChange={applyDirects}
        max={MAX_CONVERSATION_CHATS}
        otherCount={groups.length}
        disabled={blocked}
        onBusyChange={setConfirmBusy}
        fallback={
          <Textarea
            value={directsText}
            onChange={e => applyDirectsText(e.target.value)}
            rows={2}
            disabled={mutation.isPending}
            aria-label={t($ => $.lark.conversation_directs)}
            placeholder={t($ => $.lark.conversation_directs)}
          />
        }
      />
    </div>
    <p className="text-muted-foreground">{t($ => $.lark.conversation_scope)}</p>
    {overLimit && (
      <p role="alert" className="text-warning">
        {t($ => $.lark.conversation_over_limit, { max: MAX_CONVERSATION_CHATS })}
      </p>
    )}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={blocked || overLimit || (groups.length === 0 && directs.length === 0)} onClick={() => void save(false)}>{t($ => $.lark.conversation_save)}</Button>
      <Button size="sm" variant="outline" disabled={blocked} onClick={() => void save(true)}>{t($ => $.lark.conversation_revoke)}</Button>
    </div>
    {disabled && <p role="status">{t($ => $.lark.conversation_unavailable)}</p>}
    {mutation.isError && <p role="alert">{mutation.error.message}</p>}
    {saved && <p role="status">{t($ => $.lark.conversation_saved)}</p>}
  </details>;
}
