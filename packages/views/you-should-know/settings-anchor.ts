import { settingsHref } from "../settings/components/settings-navigation";

/**
 * Settings anchor of the personal You-should-know switch under Settings →
 * Notifications — the `anchor` of that row and of its search entry (OL-195).
 */
export const YOU_SHOULD_KNOW_SETTINGS_ANCHOR = "you-should-know";

/** Deep link to the personal switch, given the workspace's settings path. */
export function youShouldKnowSettingsHref(settingsPath: string): string {
  return settingsHref(settingsPath, new URLSearchParams(), "notifications", {
    section: YOU_SHOULD_KNOW_SETTINGS_ANCHOR,
  });
}
