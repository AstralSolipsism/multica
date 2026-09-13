"use client";

import { useState } from "react";
import { Plus, Search, X } from "lucide-react";
import type { LarkDiscoveredChat } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../i18n";
import { larkDiscoveryErrorKey } from "./discovery";
import { useLarkTargetCapabilities, useLarkTargetChats } from "./use-lark-discovery";
import { ChatIdDisclosure } from "./picker-common";
import { LarkChatList } from "./lark-chat-picker";
import type { LarkChatSelection } from "./picker-common";

/**
 * Multi-select group picker for the conversation-grant form (OL-74): the
 * authorized groups are chips (removed individually), new groups come from
 * an expandable browse panel that reuses the shared joined-group query with
 * name search and paging. Selection is deduplicated by chat_id and capped so
 * the (groups + direct chats) total can never exceed the server's 50-chat
 * grant limit. Raw oc_ typing remains as the caller-supplied `fallback` for
 * servers/transports without discovery.
 */
export function LarkChatMultiSelect({
  wsId,
  installationId,
  selected,
  onChange,
  max,
  otherCount,
  disabled,
  fallback,
}: {
  wsId: string;
  installationId: string;
  selected: LarkChatSelection[];
  onChange: (next: LarkChatSelection[]) => void;
  /** Total conversation cap across groups and direct chats. */
  max: number;
  /** Conversations configured outside this list (direct chats textarea). */
  otherCount: number;
  disabled?: boolean;
  fallback: React.ReactNode;
}) {
  const { t } = useT("settings");
  const [expanded, setExpanded] = useState(false);
  const caps = useLarkTargetCapabilities(wsId, installationId);
  const supported = caps.data?.chat_list_supported === true;
  const list = useLarkTargetChats(wsId, installationId, { enabled: supported && expanded });

  const selectedIds = new Set(selected.map((s) => s.chat_id));
  const atCap = selected.length + otherCount >= max;

  const toggle = (chat: LarkDiscoveredChat) => {
    if (selectedIds.has(chat.chat_id)) {
      onChange(selected.filter((s) => s.chat_id !== chat.chat_id));
      return;
    }
    if (atCap) return;
    onChange([...selected, { chat_id: chat.chat_id, name: chat.name }]);
  };

  const chips = (
    <div className="flex flex-wrap gap-1.5">
      {selected.map((sel) => {
        const label = sel.name.trim() !== "" ? sel.name : sel.chat_id;
        return (
          <span
            key={sel.chat_id}
            className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-2 pr-1 text-caption"
          >
            <span className="truncate">{label}</span>
            <ChatIdDisclosure id={sel.chat_id} />
            <button
              type="button"
              className="shrink-0 rounded-xs p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={t(($) => $.lark.picker.multi_remove, { name: label })}
              disabled={disabled}
              onClick={() => onChange(selected.filter((s) => s.chat_id !== sel.chat_id))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );

  if (!supported) {
    return (
      <div className="space-y-2">
        {selected.length > 0 && chips}
        {caps.isPending ? (
          <p className="py-1 text-caption text-muted-foreground">
            {t(($) => $.lark.picker.loading)}
          </p>
        ) : (
          <>
            <p className="text-caption text-muted-foreground">
              {caps.isError
                ? t(($) => $.lark.picker.error[larkDiscoveryErrorKey(caps.error)])
                : t(($) => $.lark.picker.error.unsupported)}
            </p>
            {fallback}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && chips}
      <p className="text-micro text-muted-foreground">
        {t(($) => $.lark.picker.multi_selected, { count: selected.length + otherCount, max })}
      </p>
      {!expanded ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setExpanded(true)}
          disabled={disabled || atCap}
        >
          <Plus className="h-3 w-3" />
          {t(($) => $.lark.picker.multi_add)}
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={list.search}
              onChange={(e) => list.setSearch(e.target.value)}
              placeholder={t(($) => $.lark.picker.search_placeholder)}
              aria-label={t(($) => $.lark.picker.search_label)}
              className="pl-8"
              disabled={disabled}
              autoFocus
            />
          </div>
          {atCap && (
            <p role="status" className="text-caption text-amber-600 dark:text-amber-500">
              {t(($) => $.lark.picker.multi_max, { max })}
            </p>
          )}
          <LarkChatList
            list={list}
            selectedIds={selectedIds}
            onToggle={toggle}
            disabled={disabled}
            isRowDisabled={(chat) => atCap && !selectedIds.has(chat.chat_id)}
            checkbox
          />
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              {t(($) => $.lark.picker.multi_done)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
