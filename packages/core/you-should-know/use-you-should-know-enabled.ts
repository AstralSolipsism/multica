"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentWorkspace } from "../paths";
import { notificationPreferenceOptions } from "../notification-preferences/queries";

export interface YouShouldKnowEnabled {
  workspaceEnabled: boolean;
  personalEnabled: boolean;
  enabled: boolean;
}

/**
 * The workspace gate for You Should Know, single source of truth for the
 * hook below and the settings-search entries: `settings.you_should_know_enabled
 * === true` — unlike `github_pr_sidebar_enabled`, a missing key means OFF
 * (the feature is opt-in per workspace).
 */
export function isYouShouldKnowWorkspaceEnabled(
  workspace: { settings?: Record<string, unknown> } | null | undefined,
): boolean {
  const settings = workspace?.settings ?? {};
  return settings.you_should_know_enabled === true;
}

/**
 * Both gates for showing You Should Know tips.
 *
 * - Workspace: `isYouShouldKnowWorkspaceEnabled` — a missing settings key
 *   means OFF (the feature is opt-in per workspace).
 * - Personal: the `you_should_know` notification preference is on unless
 *   explicitly `"muted"`. While the preference query has not produced data
 *   yet, treat it as off — a user who muted the feature must not see the
 *   bubble flash before the preference loads.
 */
export function useYouShouldKnowEnabled(): YouShouldKnowEnabled {
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id ?? "";
  const { data } = useQuery({ ...notificationPreferenceOptions(wsId), enabled: !!wsId });

  return useMemo(() => {
    const workspaceEnabled = isYouShouldKnowWorkspaceEnabled(workspace);
    // Undefined data = preferences not loaded yet → off (see docblock).
    const personalEnabled =
      data !== undefined && data.preferences.you_should_know !== "muted";
    return {
      workspaceEnabled,
      personalEnabled,
      enabled: workspaceEnabled && personalEnabled,
    };
  }, [workspace, data]);
}
