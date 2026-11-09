"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectEngineeringConfigOptions } from "@multica/core/projects/queries";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

const ENTRY_CLASS =
  "rounded-md px-2 py-1 text-caption font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * Fork-owned engineering entry links for the project detail header: an
 * "engineering overview" link when the project has engineering enabled, or an
 * "enable" link for workspace owners/admins. Self-contained: fetches the
 * engineering config and derives the role from the member list itself, so the
 * upstream project-detail.tsx only mounts this component
 * (see docs/engineering/upstream-sync-checklist.md).
 */
export function ProjectEngineeringHeaderActions({ projectId }: { projectId: string }) {
  const { t: tEngineering } = useT("engineering");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const userId = useAuthStore((s) => s.user?.id);
  const { data: engineeringOverview } = useQuery(projectEngineeringConfigOptions(wsId, projectId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const role = members.find((m) => m.user_id === userId)?.role ?? null;
  const isWorkspaceAdmin = role === "owner" || role === "admin";
  const enabled = engineeringOverview?.engineering?.enabled === true;

  if (enabled) {
    return (
      <AppLink
        href={wsPaths.projectEngineering(projectId)}
        newTabTitle={tEngineering(($) => $.title)}
        className={ENTRY_CLASS}
      >
        {tEngineering(($) => $.title)}
      </AppLink>
    );
  }
  if (isWorkspaceAdmin && engineeringOverview?.engineering) {
    return (
      <AppLink
        href={wsPaths.projectEngineering(projectId)}
        newTabTitle={tEngineering(($) => $.actions.enable)}
        className={ENTRY_CLASS}
      >
        {tEngineering(($) => $.actions.enable)}
      </AppLink>
    );
  }
  return null;
}
