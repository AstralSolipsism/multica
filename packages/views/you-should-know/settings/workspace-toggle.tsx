"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useCurrentWorkspace } from "@multica/core/paths";
import { useYouShouldKnowEnabled } from "@multica/core/you-should-know";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { Switch } from "@multica/ui/components/ui/switch";
import type { Workspace } from "@multica/core/types";
import { useT } from "../../i18n";
import { SettingsCard, SettingsRow, SettingsSection } from "../../settings/components/settings-layout";

/**
 * Settings → General: the workspace-wide You should know switch. Persists
 * `settings.you_should_know_enabled` through `api.updateWorkspace` (merged
 * over the existing settings, like code-tab's persistSetting). Read-only for
 * members; the `canManage` gate comes from WorkspaceTab so both agree.
 */
export function YouShouldKnowWorkspaceSection({ canManage }: { canManage: boolean }) {
  const { t } = useT("you-should-know");
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const { workspaceEnabled } = useYouShouldKnowEnabled();
  const [saving, setSaving] = useState(false);

  const persist = async (next: boolean) => {
    if (!workspace || saving || !canManage) return;
    setSaving(true);
    try {
      const merged = {
        ...((workspace.settings as Record<string, unknown>) ?? {}),
        you_should_know_enabled: next,
      };
      const updated = await api.updateWorkspace(workspace.id, { settings: merged });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((ws) => (ws.id === updated.id ? updated : ws)),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.errors.state_failed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={t(($) => $.settings.title)} anchor="you-should-know">
      <SettingsCard>
        <SettingsRow label={t(($) => $.settings.workspace_label)}>
          <Switch
            checked={workspaceEnabled}
            disabled={!canManage || saving}
            onCheckedChange={persist}
            aria-label={t(($) => $.settings.workspace_label)}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
