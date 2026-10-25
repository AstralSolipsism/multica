import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeListOptions } from "@multica/core/runtimes";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import type { AgentRuntime, AgentTask } from "@multica/core/types";

export interface LocalDaemonActivity {
  /** Runtimes registered by this machine's daemon in the current workspace. */
  runtimeCount: number;
  /** Workspace tasks running or dispatched on this machine's daemon — the set
   *  a daemon stop/restart would interrupt. */
  affectedTasks: AgentTask[];
}

/**
 * Pure form of the local-daemon activity join, kept separate from the hook so
 * the status/runtime matrix stays unit-testable without React Query. Only
 * "running" and "dispatched" tasks would actually be interrupted by a daemon
 * restart — queued work is still server-side.
 */
export function selectLocalDaemonActivity(
  runtimes: AgentRuntime[],
  snapshot: AgentTask[],
  daemonId: string | undefined,
): LocalDaemonActivity {
  if (!daemonId) return { runtimeCount: 0, affectedTasks: [] };
  const localRuntimeIds = new Set(
    runtimes.filter((r) => r.daemon_id === daemonId).map((r) => r.id),
  );
  return {
    runtimeCount: localRuntimeIds.size,
    affectedTasks: snapshot.filter(
      (t) =>
        localRuntimeIds.has(t.runtime_id) &&
        (t.status === "running" || t.status === "dispatched"),
    ),
  };
}

/**
 * Live view of what this machine's daemon is doing in the current workspace.
 * Shared by the runtimes-page daemon card (stop confirmation, panel header)
 * and the daemon settings tab (workspaces-root change confirmation).
 */
export function useLocalDaemonActivity(
  daemonId: string | undefined,
): LocalDaemonActivity {
  const wsId = useWorkspaceId();
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const { data: snapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));
  return useMemo(
    () => selectLocalDaemonActivity(runtimes, snapshot, daemonId),
    [runtimes, snapshot, daemonId],
  );
}
