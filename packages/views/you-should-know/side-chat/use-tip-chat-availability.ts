"use client";

import { useQuery } from "@tanstack/react-query";
import { isAgentRuntimeBound } from "@multica/core/agents";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Agent } from "@multica/core/types";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import type { TipChatBlockReason } from "@multica/core/you-should-know";
import { canAssignAgent } from "../../issues/components/pickers/assignee-picker";

/**
 * Why this member cannot chat with the agent, in the open endpoint's order:
 * access first (an agent they cannot see counts as no access), then archive,
 * then runtime. An offline runtime still counts as bound.
 */
export function tipChatBlockReasonFor(
  agent: Agent | null,
  userId: string | undefined,
  memberRole: string | undefined,
): TipChatBlockReason | null {
  if (!agent || !canAssignAgent(agent, userId, memberRole)) return "invocation_not_allowed";
  if (agent.archived_at) return "agent_archived";
  if (!isAgentRuntimeBound(agent)) return "agent_no_runtime";
  return null;
}

export interface TipChatAvailability {
  /** Null while the directories load: the server has the last word then. */
  reason: TipChatBlockReason | null;
  /** The agent's name, or null when this member cannot see the agent. */
  agentName: string | null;
}

/** Whether the member can chat with the agent that produced a tip. */
export function useTipChatAvailability(agentId: string): TipChatAvailability {
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id);
  const agents = useQuery(agentListOptions(wsId));
  const members = useQuery(memberListOptions(wsId));
  const agent = agents.data?.find((candidate) => candidate.id === agentId) ?? null;
  const settled = agents.isSuccess && members.isSuccess;
  const role = members.data?.find((member) => member.user_id === userId)?.role;
  return {
    reason: settled ? tipChatBlockReasonFor(agent, userId, role) : null,
    agentName: agent?.name ?? null,
  };
}
