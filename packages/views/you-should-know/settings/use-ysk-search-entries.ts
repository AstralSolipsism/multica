"use client";

import { useMemo } from "react";
import { useCurrentWorkspace } from "@multica/core/paths";
import { isYouShouldKnowWorkspaceEnabled } from "@multica/core/you-should-know";
import type { SettingsSearchEntry } from "../../settings/components/settings-search";
import { useT } from "../../i18n";

/**
 * Settings-search entries for the personal YSK switch row. The row only
 * renders while the workspace switch is on, so its entry must appear and
 * disappear with it — a search hit that lands on a missing row is a dead
 * result. Reads the workspace setting directly (not useYouShouldKnowEnabled,
 * whose preference query this hook does not need).
 */
export function useYouShouldKnowSearchEntries(): SettingsSearchEntry[] {
  const { t } = useT("you-should-know");
  const workspace = useCurrentWorkspace();
  const workspaceEnabled = isYouShouldKnowWorkspaceEnabled(workspace);
  return useMemo(
    () =>
      workspaceEnabled
        ? [
            {
              tab: "notifications",
              anchor: "you-should-know",
              title: t(($) => $.settings.personal_label),
            },
          ]
        : [],
    [workspaceEnabled, t],
  );
}
