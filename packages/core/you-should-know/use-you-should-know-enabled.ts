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
 * Both gates for showing You Should Know tips.
 *
 * - Workspace: `settings.you_should_know_enabled === true` — unlike
 *   `github_pr_sidebar_enabled`, a missing key means OFF (the feature is
 *   opt-in per workspace).
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
    const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
    const workspaceEnabled = settings.you_should_know_enabled === true;
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
