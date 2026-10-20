import { z } from "zod";
import type { GitHubInstallation, ListGitHubAppInstallationsResponse } from "../types";

// Labrastro fork: reusable GitHub App installations, served by
// server/internal/handler/labrastro_github_installations.go (OL-928).

export const GitHubAppInstallationSchema = z.object({
  installation_id: z.number(),
  account_login: z.string(),
  account_type: z.string().catch(""),
  account_avatar_url: z.string().nullable().optional().default(null),
  connected: z.boolean().optional().default(false),
}).loose();

// A malformed list degrades to "nothing to reuse": connecting then falls back
// to GitHub's install page instead of being blocked.
export const ListGitHubAppInstallationsResponseSchema = z.object({
  installations: z.array(GitHubAppInstallationSchema).default([]),
  configured: z.boolean().optional().default(false),
}).loose();

export const EMPTY_LIST_GITHUB_APP_INSTALLATIONS_RESPONSE: ListGitHubAppInstallationsResponse = {
  installations: [],
  configured: false,
};

export const EMPTY_GITHUB_INSTALLATION: GitHubInstallation = {
  id: "",
  workspace_id: "",
  account_login: "",
  account_type: "User",
  account_avatar_url: null,
  created_at: "",
};
