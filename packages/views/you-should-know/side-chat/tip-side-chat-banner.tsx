"use client";

import { useWorkspacePaths } from "@multica/core/paths";
import type { TipChatSource } from "@multica/core/you-should-know";
import { cn } from "@multica/ui/lib/utils";
import { CHAT_COLUMN, CHAT_GUTTER } from "../../chat/components/chat-column";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { BYSTANDER_MARKER } from "../bubble/bystander-marker";

/**
 * The tip a side chat is about, pinned above the conversation in the floating
 * chat and on the Chat page (OL-288 §3): `✦ tag · line`, the explanation, a
 * link back to the issue, and a note that this chat leaves the agent's
 * running work alone. Rendered from the snapshot taken when the chat opened.
 */
export function TipSideChatBanner({
  source,
  agentName,
}: {
  source: TipChatSource;
  /** The session's agent; null while it is not resolvable. */
  agentName: string | null;
}) {
  const { t } = useT("you-should-know");
  const paths = useWorkspacePaths();
  const { tip } = source;
  const agent = agentName ?? t(($) => $.side_chat.unknown_agent);
  const invalidNote =
    tip.status === "source_changed"
      ? t(($) => $.archive.source_changed)
      : tip.status === "overturned"
        ? [t(($) => $.archive.overturned), tip.overturned_reason].filter(Boolean).join(" · ")
        : null;

  return (
    <section
      data-ysk-side-chat-banner=""
      aria-label={t(($) => $.side_chat.banner_label)}
      className={cn(CHAT_GUTTER, "shrink-0 border-b py-2.5 text-caption")}
    >
      <div className={cn(CHAT_COLUMN, "flex flex-col gap-1")}>
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-brand" aria-hidden="true">
            {BYSTANDER_MARKER}
          </span>
          <span className={cn("shrink-0 font-medium", tip.tag === "heads_up" && "text-warning")}>
            {t(($) => $.tag[tip.tag])}
          </span>
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 break-words">{tip.line}</span>
        </p>
        {tip.explanation && (
          // Long explanations scroll in place rather than push the
          // conversation out of a small window.
          <p className="max-h-28 overflow-y-auto whitespace-pre-line text-muted-foreground">
            {tip.explanation}
          </p>
        )}
        {invalidNote && <p className="text-micro text-muted-foreground">{invalidNote}</p>}
        <AppLink
          href={paths.issueDetail(source.issue_id)}
          className="w-fit rounded-sm text-micro font-medium text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(($) => $.side_chat.open_issue, { identifier: source.issue_identifier })}
        </AppLink>
        <p className="text-micro text-muted-foreground">
          {t(($) => $.side_chat.independent_note, { agent })}
        </p>
      </div>
    </section>
  );
}
