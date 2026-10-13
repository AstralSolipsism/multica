"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { notificationPreferenceOptions } from "@multica/core/notification-preferences/queries";
import { useUpdateNotificationPreferences } from "@multica/core/notification-preferences/mutations";
import { useWorkspaceId } from "@multica/core/hooks";
import { useYouShouldKnowEnabled } from "@multica/core/you-should-know";
import type { NotificationPreferences } from "@multica/core/types";
import { Switch } from "@multica/ui/components/ui/switch";
import { useT } from "../../i18n";
import { SettingsRow } from "../../settings/components/settings-layout";

/**
 * Settings → Notifications: the personal You should know switch. On maps to
 * the `you_should_know` preference `all` (omitted — the default), off maps to
 * `muted`, saved with `useUpdateNotificationPreferences`. Renders nothing
 * while the workspace switch is off: a personal toggle with no effect would
 * only confuse.
 */
export function YouShouldKnowPersonalRow() {
  const { t } = useT("you-should-know");
  const wsId = useWorkspaceId();
  const { workspaceEnabled } = useYouShouldKnowEnabled();
  const { data } = useQuery({ ...notificationPreferenceOptions(wsId), enabled: workspaceEnabled });
  const mutation = useUpdateNotificationPreferences();

  if (!workspaceEnabled) return null;

  const enabled = data?.preferences.you_should_know !== "muted";

  const toggle = (next: boolean) => {
    const updated: NotificationPreferences = {
      ...(data?.preferences ?? {}),
      you_should_know: next ? "all" : "muted",
    };
    // "all" is the default; omit it to keep the stored object clean.
    if (next) delete updated.you_should_know;
    mutation.mutate(updated, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.state_failed),
        ),
    });
  };

  return (
    <SettingsRow
      anchor="you-should-know"
      label={t(($) => $.settings.personal_label)}
      description={t(($) => $.settings.personal_description)}
    >
      <Switch
        checked={enabled}
        onCheckedChange={toggle}
        aria-label={t(($) => $.settings.personal_label)}
      />
    </SettingsRow>
  );
}
