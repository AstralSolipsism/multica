"use client";

import type { Agent } from "@multica/core/types";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { cn } from "@multica/ui/lib/utils";

export function AgentFolderAvatars({ agents, count, emptyLabel }: {
  /** Scoped members in preview order; this component owns the responsive limit. */
  agents: readonly Agent[];
  count: number;
  emptyLabel: string;
}) {
  if (count === 0) {
    return <span className="shrink-0 rounded-full border border-dashed px-2 text-caption text-muted-foreground">{emptyLabel}</span>;
  }

  const ring = "ring-2 ring-[var(--folder-row-background)]";
  const overflow = "size-6 shrink-0 items-center justify-center rounded-full bg-border text-caption tabular-nums text-muted-foreground";
  return (
    <span className="flex shrink-0 items-center -space-x-1.5">
      {agents.slice(0, 4).map((agent, index) => (
        <span key={agent.id} title={agent.name} className={cn("inline-flex rounded-full", ring, index === 3 && "hidden @2xl:inline-flex")}>
          <ActorAvatar
            name={agent.name}
            initials={agent.name.slice(0, 1)}
            avatarUrl={resolvePublicFileUrl(agent.avatar_url)}
            isAgent
            size="md"
          />
        </span>
      ))}
      {count > 3 && <span className={cn(overflow, ring, "inline-flex @2xl:hidden")}>+{count - 3}</span>}
      {count > 4 && <span className={cn(overflow, ring, "hidden @2xl:inline-flex")}>+{count - 4}</span>}
    </span>
  );
}
