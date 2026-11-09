"use client";

import { useQuery } from "@tanstack/react-query";
import { Folder } from "@multica/ui/icons";
import { DropdownMenuItem } from "@multica/ui/components/ui/dropdown-menu";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectEngineeringConfigOptions } from "@multica/core/projects/queries";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";

/**
 * Fork-owned engineering entry for the sidebar project row menu. Fetches the
 * engineering config and member role itself (only while `active`, i.e. the
 * space panel is open and the menu is showing) and renders the open/enable
 * item, or a disabled placeholder while loading or when the viewer cannot
 * enter (see docs/engineering/upstream-sync-checklist.md).
 */
export function ProjectEngineeringMenuItems({
  wsId,
  projectId,
  userId,
  active,
}: {
  wsId: string;
  projectId: string;
  userId: string | null | undefined;
  active: boolean;
}) {
  const { t: tEngineering } = useT("engineering");
  const { t: tCommon } = useT("common");
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const { data: engineeringOverview, isPending: engineeringPending } = useQuery({
    ...projectEngineeringConfigOptions(wsId, projectId),
    enabled: active,
  });
  const { data: members = [], isPending: membersPending } = useQuery({
    ...memberListOptions(wsId),
    enabled: active,
  });
  const isWorkspaceAdmin = members.some(
    (member) =>
      member.user_id === userId && (member.role === "owner" || member.role === "admin"),
  );
  const engineeringEnabled = engineeringOverview?.engineering.enabled === true;
  const showEngineering = engineeringEnabled || (!!engineeringOverview && isWorkspaceAdmin);

  if (showEngineering) {
    return (
      <DropdownMenuItem onClick={() => push(p.projectEngineering(projectId))}>
        <Folder className="size-3.5" />
        {engineeringEnabled
          ? tEngineering(($) => $.actions.open_baseline)
          : tEngineering(($) => $.actions.enable)}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem disabled>
      {engineeringPending || membersPending
        ? tCommon(($) => $.loading)
        : tEngineering(($) => $.disabled.title)}
    </DropdownMenuItem>
  );
}
