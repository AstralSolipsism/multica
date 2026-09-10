"use client";

import { useState } from "react";
import { useSetLarkConversation } from "@multica/core/lark";
import type { LarkInstallation } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";

export function LarkConversationForm({ workspaceId, installation, disabled }: {
  workspaceId: string; installation: LarkInstallation; disabled: boolean;
}) {
  const { t } = useT("settings");
  const [groups, setGroups] = useState(() => installation.conversation?.chats.filter(c => c.chat_type === "group").map(c => c.chat_id).join("\n") ?? "");
  const [directs, setDirects] = useState(() => installation.conversation?.chats.filter(c => c.chat_type === "p2p").map(c => c.chat_id).join("\n") ?? "");
  const mutation = useSetLarkConversation(workspaceId, installation.id);
  const [saved, setSaved] = useState(false);
  const blocked = disabled || mutation.isPending;
  async function save(revoke: boolean) {
    if (blocked) return;
    setSaved(false);
    const chats = revoke ? [] : [
      ...groups.split(/\s+/).filter(Boolean).map(chat_id => ({ chat_id, chat_type: "group" as const })),
      ...directs.split(/\s+/).filter(Boolean).map(chat_id => ({ chat_id, chat_type: "p2p" as const })),
    ];
    try {
      await mutation.mutateAsync(chats);
      if (revoke) { setGroups(""); setDirects(""); }
      setSaved(true);
    } catch { /* The mutation error stays visible with the draft intact. */ }
  }
  return <details className="mt-3 max-w-xl space-y-3 text-caption">
    <summary className="cursor-pointer font-medium">{t($ => $.lark.conversation_title)}</summary>
    <p className="text-muted-foreground">{t($ => $.lark.conversation_description)}</p>
    <label className="block space-y-1">{t($ => $.lark.conversation_groups)}
      <Textarea value={groups} onChange={e => { setGroups(e.target.value); setSaved(false); }} rows={2} disabled={mutation.isPending} />
    </label>
    <label className="block space-y-1">{t($ => $.lark.conversation_directs)}
      <Textarea value={directs} onChange={e => { setDirects(e.target.value); setSaved(false); }} rows={2} disabled={mutation.isPending} />
    </label>
    <p className="text-muted-foreground">{t($ => $.lark.conversation_scope)}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={blocked || (!groups.trim() && !directs.trim())} onClick={() => void save(false)}>{t($ => $.lark.conversation_save)}</Button>
      <Button size="sm" variant="outline" disabled={blocked} onClick={() => void save(true)}>{t($ => $.lark.conversation_revoke)}</Button>
    </div>
    {disabled && <p role="status">{t($ => $.lark.conversation_unavailable)}</p>}
    {mutation.isError && <p role="alert">{mutation.error.message}</p>}
    {saved && <p role="status">{t($ => $.lark.conversation_saved)}</p>}
  </details>;
}
