"use client";

import { useId, useState, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { workspaceKeys } from "@multica/core/workspace/queries";
import {
  tipChatBlockReason,
  useOpenTipChat,
  type IssueTip,
  type TipChatBlockReason,
} from "@multica/core/you-should-know";
import { Button } from "@multica/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { useLocale, useT } from "../../i18n";
import { usePrefersReducedMotion } from "../bubble/page-signals";
import { useSideChatOpener } from "./open-chat-session";
import { useTipChatAvailability } from "./use-tip-chat-availability";

/** The localized sentence for a refusal, naming the agent. */
export function useTipChatBlockText(): (reason: TipChatBlockReason, agentName: string | null) => string {
  const { t } = useT("you-should-know");
  const locale = useLocale();
  return (reason, agentName) => {
    const agent = agentName ?? t(($) => $.side_chat.unknown_agent);
    const text =
      reason === "agent_archived"
        ? t(($) => $.side_chat.blocked.agent_archived, { agent })
        : reason === "agent_no_runtime"
          ? t(($) => $.side_chat.blocked.agent_no_runtime, { agent })
          : t(($) => $.side_chat.blocked.invocation_not_allowed, { agent });
    // "this agent" can open the sentence; an agent's own name is left as is.
    return agentName ? text : text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  };
}

/**
 * "Ask about this" (OL-288 §2/§3): opens the private side chat with the agent
 * that produced the tip, on the card and in the issue's archive alike. The
 * tip's state is left as it is — "Got it" stays the way to retire it.
 *
 * An agent the member cannot chat with greys the button out and says why —
 * on hover, and as its accessible description. A refusal from the server
 * does the same, since the directories it is judged from can lag. Never
 * falls back to another agent.
 */
export function AskAboutTipButton({
  tip,
  className,
}: {
  tip: Pick<IssueTip, "id" | "agent_id">;
  className?: string;
}) {
  const { t } = useT("you-should-know");
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const reducedMotion = usePrefersReducedMotion();
  const availability = useTipChatAvailability(tip.agent_id);
  const blockText = useTipChatBlockText();
  const openSession = useSideChatOpener();
  const openTipChat = useOpenTipChat();
  // A server refusal, with the local verdict it overruled. It stands until
  // that verdict changes — the directories refetched below catch up, or the
  // agent is fixed later — and from then on the local verdict speaks.
  const [refusal, setRefusal] = useState<{
    reason: TipChatBlockReason;
    overruled: TipChatBlockReason | null;
  } | null>(null);
  if (refusal && refusal.overruled !== availability.reason) setRefusal(null);
  const reasonId = useId();

  const reason = refusal?.reason ?? availability.reason;
  const reasonText = reason ? blockText(reason, availability.agentName) : null;

  const ask = (event: MouseEvent) => {
    // The second click of a double-click lands on whatever replaced the
    // previous button; it is not a request of its own.
    if (event.detail > 1 || reason || openTipChat.isPending) return;
    openTipChat.mutateAsync(tip.id).then(
      (session) => openSession(session.id),
      (err: unknown) => {
        const refused = tipChatBlockReason(err);
        if (!refused) {
          toast.error(t(($) => $.errors.open_chat_failed));
          return;
        }
        setRefusal({ reason: refused, overruled: availability.reason });
        toast.error(blockText(refused, availability.agentName));
        // Let the local verdict catch up with the server's.
        void qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
        void qc.invalidateQueries({ queryKey: workspaceKeys.members(wsId) });
      },
    );
  };

  // One tree whether or not there is a reason, so a refusal arriving while
  // the button has focus does not remount it and drop that focus.
  return (
    <>
      <Tooltip disabled={!reasonText}>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!!reason || openTipChat.isPending}
              focusableWhenDisabled
              aria-busy={openTipChat.isPending || undefined}
              aria-describedby={reasonText ? reasonId : undefined}
              className={cn(
                "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent",
                reducedMotion && "transition-none",
                className,
              )}
              onClick={ask}
            />
          }
        >
          {t(($) => $.card.ask)}
        </TooltipTrigger>
        {reasonText && <TooltipContent side="top">{reasonText}</TooltipContent>}
      </Tooltip>
      {reasonText && (
        <span id={reasonId} hidden>
          {reasonText}
        </span>
      )}
    </>
  );
}
