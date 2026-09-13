"use client";

import { useState } from "react";
import { useSetLarkConversation } from "@multica/core/lark";
import type { LarkInstallation } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { LarkChatMultiSelect, type LarkChatSelection } from "../../lark";

/** Server-side conversation grant cap (scope must be workspace; at most 50
 * chats — server/internal/handler/labrastro_conversation.go). The picker
 * enforces it live so the user sees the limit before the server rejects. */
const MAX_CONVERSATION_CHATS = 50;

/**
 * Conversation authorization for one bot installation (OL-74 rework): the
 * authorized GROUPS are picked from the bot's joined-group list
 * (LarkChatMultiSelect) instead of typed as raw oc_ IDs; direct-chat (p2p)
 * configuration keeps the existing manual entry — candidate confirmation UI
 * for p2p belongs to OL-76, out of scope here. Manual save/revoke, dedupe
 * and the 50-chat cap are preserved; a failed save keeps the draft.
 */
export function LarkConversationForm({ workspaceId, installation, disabled }: {
  workspaceId: string; installation: LarkInstallation; disabled: boolean;
}) {
  const { t } = useT("settings");
  // Two representations of the same group set: the picker edits the array;
  // the legacy textarea (fallback when discovery is unsupported) edits the
  // text. Both are kept in sync so save always derives from the array.
  const [groups, setGroups] = useState<LarkChatSelection[]>(() =>
    installation.conversation?.chats
      .filter((c) => c.chat_type === "group")
      .map((c) => ({ chat_id: c.chat_id, name: "" })) ?? []);
  const [groupsText, setGroupsText] = useState(() =>
    installation.conversation?.chats
      .filter((c) => c.chat_type === "group")
      .map((c) => c.chat_id)
      .join("\n") ?? "");
  const [directs, setDirects] = useState(() => installation.conversation?.chats.filter(c => c.chat_type === "p2p").map(c => c.chat_id).join("\n") ?? "");
  const mutation = useSetLarkConversation(workspaceId, installation.id);
  const [saved, setSaved] = useState(false);
  const blocked = disabled || mutation.isPending;

  const directIds = [...new Set(directs.split(/\s+/).filter(Boolean))];
  const overLimit = groups.length + directIds.length > MAX_CONVERSATION_CHATS;

  function applyGroups(next: LarkChatSelection[]) {
    // Dedupe by chat_id — a duplicate conversation is a 400 server-side.
    const seen = new Set<string>();
    const deduped = next.filter((g) => !seen.has(g.chat_id) && seen.add(g.chat_id));
    setGroups(deduped);
    setGroupsText(deduped.map((g) => g.chat_id).join("\n"));
    setSaved(false);
  }

  function applyGroupsText(text: string) {
    setGroupsText(text);
    const seen = new Set<string>();
    setGroups(
      text.split(/\s+/).filter(Boolean)
        .filter((id) => !seen.has(id) && seen.add(id))
        .map((chat_id) => ({ chat_id, name: "" })),
    );
    setSaved(false);
  }

  async function save(revoke: boolean) {
    if (blocked) return;
    setSaved(false);
    const chats = revoke ? [] : [
      ...groups.map((g) => ({ chat_id: g.chat_id, chat_type: "group" as const })),
      ...directIds.map((chat_id) => ({ chat_id, chat_type: "p2p" as const })),
    ];
    try {
      await mutation.mutateAsync(chats);
      if (revoke) { applyGroups([]); setDirects(""); }
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
        otherCount={directIds.length}
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
    <label className="block space-y-1">{t($ => $.lark.conversation_directs)}
      <Textarea value={directs} onChange={e => { setDirects(e.target.value); setSaved(false); }} rows={2} disabled={mutation.isPending} />
    </label>
    <p className="text-muted-foreground">{t($ => $.lark.conversation_scope)}</p>
    {overLimit && (
      <p role="alert" className="text-amber-600 dark:text-amber-500">
        {t($ => $.lark.conversation_over_limit, { max: MAX_CONVERSATION_CHATS })}
      </p>
    )}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={blocked || overLimit || (groups.length === 0 && directIds.length === 0)} onClick={() => void save(false)}>{t($ => $.lark.conversation_save)}</Button>
      <Button size="sm" variant="outline" disabled={blocked} onClick={() => void save(true)}>{t($ => $.lark.conversation_revoke)}</Button>
    </div>
    {disabled && <p role="status">{t($ => $.lark.conversation_unavailable)}</p>}
    {mutation.isError && <p role="alert">{mutation.error.message}</p>}
    {saved && <p role="status">{t($ => $.lark.conversation_saved)}</p>}
  </details>;
}
