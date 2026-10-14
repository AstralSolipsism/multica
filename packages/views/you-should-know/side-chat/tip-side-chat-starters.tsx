"use client";

import { useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { CHAT_COLUMN, CHAT_GUTTER } from "../../chat/components/chat-column";
import { useT } from "../../i18n";
import { usePrefersReducedMotion } from "../bubble/page-signals";

/**
 * A side chat before its first visible message (OL-288 §3): three common
 * questions in place of the agent's usual starters, laid out right above the
 * composer. A pick is sent as the member's own message through the surface's
 * normal send — the composer and its draft are left alone. Once the chat has
 * a visible message the surface shows the conversation instead.
 */
export function TipSideChatStarters({
  onPick,
  disabled,
}: {
  /** The surface's send; resolves once the server accepted or refused it. */
  onPick: (prompt: string) => Promise<unknown>;
  /** The composer is unavailable (agent archived, no access, no runtime…). */
  disabled: boolean;
}) {
  const { t } = useT("you-should-know");
  const reducedMotion = usePrefersReducedMotion();
  const [sending, setSending] = useState(false);
  const questions = [
    t(($) => $.side_chat.starters.more),
    t(($) => $.side_chat.starters.why),
    t(($) => $.side_chat.starters.impact),
  ];

  const pick = (question: string) => {
    if (sending) return;
    setSending(true);
    void onPick(question).finally(() => setSending(false));
  };

  return (
    <div className={cn(CHAT_GUTTER, "flex min-h-0 flex-1 flex-col justify-end overflow-y-auto pb-2")}>
      <div
        role="group"
        aria-label={t(($) => $.side_chat.starters_label)}
        className={cn(CHAT_COLUMN, "flex flex-wrap gap-1.5")}
      >
        {questions.map((question) => (
          <Button
            key={question}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || sending}
            // Keeps focus on the picked question while it is being sent.
            focusableWhenDisabled
            aria-busy={sending || undefined}
            className={cn(
              "h-auto min-h-7 whitespace-normal text-left aria-disabled:pointer-events-none aria-disabled:opacity-50",
              reducedMotion && "transition-none",
            )}
            onClick={() => pick(question)}
          >
            {question}
          </Button>
        ))}
      </div>
    </div>
  );
}
