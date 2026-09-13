"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@multica/ui/components/ui/avatar";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { chatIdSuffix, type LarkDiscoveryErrorKey } from "./discovery";

/** One selection made in a picker. `name` is a display snapshot only — the
 * persisted identity is always the raw chat/message ID. "" means the ID was
 * restored from a saved target whose name discovery has not resolved. */
export interface LarkChatSelection {
  chatId: string;
  name: string;
}

export interface LarkAnchorSelection {
  messageId: string;
  summary: string;
  threadId?: string;
}

/** Stable-code → localized sentence for every discovery failure, with the
 * recovery action the contract prescribes: cursor failures restart from page
 * one, everything else retries. */
export function LarkDiscoveryErrorAlert({
  errorKey,
  onRetry,
  onRestart,
}: {
  errorKey: LarkDiscoveryErrorKey;
  onRetry?: () => void;
  onRestart?: () => void;
}) {
  const { t } = useT("settings");
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-center justify-between gap-2">
        <span>{t(($) => $.lark.picker.error[errorKey])}</span>
        {errorKey === "invalid_cursor" ? (
          <Button size="sm" variant="outline" onClick={onRestart}>
            <RefreshCw className="h-3 w-3" />
            {t(($) => $.lark.picker.restart)}
          </Button>
        ) : (
          onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw className="h-3 w-3" />
              {t(($) => $.lark.picker.retry)}
            </Button>
          )
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Rows are not <button> elements (they host this toggle), so the suffix →
 * full-ID expansion is its own keyboard-focusable control. stopPropagation
 * keeps the toggle from selecting the row. */
export function ChatIdDisclosure({ id }: { id: string }) {
  const { t } = useT("settings");
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <code className="truncate font-mono text-micro text-muted-foreground">
        {open ? id : `…${chatIdSuffix(id)}`}
      </code>
      <button
        type="button"
        className="shrink-0 rounded-xs p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label={open ? t(($) => $.lark.picker.hide_id) : t(($) => $.lark.picker.show_id)}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
    </span>
  );
}

/** Group avatar with a name-initial fallback; the provider URL may be empty. */
export function LarkChatAvatar({ name, avatar }: { name: string; avatar: string }) {
  return (
    <Avatar className="h-7 w-7 shrink-0">
      {avatar !== "" && <AvatarImage src={avatar} alt="" />}
      <AvatarFallback className="text-micro">
        {(name.trim()[0] ?? "?").toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
