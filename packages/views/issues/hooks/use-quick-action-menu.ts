"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { useAuthStore } from "@multica/core/auth";
import { useCurrentWorkspace } from "@multica/core/paths";
import { canAssignAgentToIssue } from "@multica/core/permissions";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { buildQuickActionBody, quickActionListOptions } from "@multica/core/quick-actions";
import type { Agent, AgentSkillSummary, Issue, MemberWithUser, Squad } from "@multica/core/types";
import {
  agentListOptions,
  memberListOptions,
  squadListOptions,
} from "@multica/core/workspace/queries";
import { useT } from "../../i18n";

export interface IssueSlashSkillContext {
  issue?: Pick<Issue, "assignee_type" | "assignee_id">;
  agents: Agent[];
  squads: Squad[];
  members: MemberWithUser[];
  userId: string | null;
}

/** Reads target mentions from the live document; no Markdown/debounce round-trip. */
export function resolveIssueSlashSkills(
  doc: Node,
  { issue, agents, squads, members, userId }: IssueSlashSkillContext,
): AgentSkillSummary[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const squadsById = new Map(squads.map((squad) => [squad.id, squad]));
  const targetIds: string[] = [];
  let hasExplicitTarget = false;

  doc.descendants((node) => {
    if (node.type.name !== "mention") return;
    const { type, id } = node.attrs as { type?: string; id?: string };
    if (!id) return;
    if (type === "agent") {
      hasExplicitTarget = true;
      targetIds.push(id);
    } else if (type === "squad") {
      hasExplicitTarget = true;
      const squad = squadsById.get(id);
      if (squad && !squad.archived_at) targetIds.push(squad.leader_id);
    }
  });

  // Explicit agent/squad mentions lock scope even when unresolved, archived,
  // empty, or unauthorized; the Issue assignee is only a no-explicit-target fallback.
  if (!hasExplicitTarget && issue?.assignee_id) {
    if (issue.assignee_type === "agent") {
      targetIds.push(issue.assignee_id);
    } else if (issue.assignee_type === "squad") {
      const squad = squadsById.get(issue.assignee_id);
      if (squad && !squad.archived_at) targetIds.push(squad.leader_id);
    }
  }

  const memberRole = members.find((member) => member.user_id === userId)?.role ?? null;
  const seenAgentIds = new Set<string>();
  const seenSkillIds = new Set<string>();
  const skills: AgentSkillSummary[] = [];
  for (const agentId of targetIds) {
    if (seenAgentIds.has(agentId)) continue;
    seenAgentIds.add(agentId);
    const agent = agentsById.get(agentId);
    if (
      !agent ||
      agent.archived_at ||
      !canAssignAgentToIssue(agent, { userId, role: memberRole }).allowed
    ) continue;
    for (const skill of agent.skills) {
      if (skill.enabled === false || seenSkillIds.has(skill.id)) continue;
      seenSkillIds.add(skill.id);
      skills.push(skill);
    }
  }
  return skills;
}

/**
 * Supplies the comment composer's `/` menu with this workspace's quick actions
 * and the enabled skills bound to its current Issue target agents (MUL-5465).
 *
 * Picking one INSERTS the cached body rather than running it — the composer
 * path exists precisely for the "this time is different" case, so the user
 * gets to edit and then send with the normal shortcut. Running without review
 * is what the sidebar button is for.
 *
 * The menu offers the same catalog the sidebar shows. Inserting draft text
 * needs no invocation preflight; the comment send path checks permission just
 * as it does for a hand-typed mention.
 *
 * Reads workspace identity through `useCurrentWorkspace` (nullable) rather
 * than `useWorkspaceId` (throws): the comment composer also mounts outside a
 * workspace route, and an enhancement like this must degrade to "no quick
 * actions in the menu", never take the composer down with it.
 */
export function useQuickActionMenu(issueId?: string) {
  const { t } = useT("issues");
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id ?? "";
  const hasIssueContext = wsId !== "" && !!issueId;
  const { data } = useQuery({
    ...quickActionListOptions(wsId),
    enabled: wsId !== "",
  });
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: hasIssueContext,
  });
  const { data: agents } = useQuery({
    ...agentListOptions(wsId),
    enabled: hasIssueContext,
  });
  const { data: squads } = useQuery({
    ...squadListOptions(wsId),
    enabled: hasIssueContext,
  });
  const { data: members } = useQuery({
    ...memberListOptions(wsId),
    enabled: hasIssueContext,
  });

  const actions = useMemo(
    () => (data ?? []).filter((a) => a.status === "active"),
    [data],
  );

  const getQuickActions = useCallback(
    () => actions.map((a) => ({ id: a.id, name: a.name, description: a.description || undefined })),
    [actions],
  );
  const getQuickActionContent = useCallback((quickActionId: string) => {
    const action = actions.find((a) => a.id === quickActionId);
    if (!action) return "";
    const content = buildQuickActionBody(action);
    if (content === null) {
      toast.error(t(($) => $.comment.trigger_blocked_target_unavailable));
      return "";
    }
    return content;
  }, [actions, t]);

  const getSkills = useCallback((editor: Editor): AgentSkillSummary[] => {
    if (!hasIssueContext) return [];
    return resolveIssueSlashSkills(editor.state.doc, {
      issue,
      agents: agents ?? [],
      squads: squads ?? [],
      members: members ?? [],
      userId: useAuthStore.getState().user?.id ?? null,
    });
  }, [hasIssueContext, issue, agents, squads, members]);

  return useMemo(
    () => ({ getQuickActions, getQuickActionContent, getSkills }),
    [getQuickActions, getQuickActionContent, getSkills],
  );
}
