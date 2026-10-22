// Labrastro fork: bind a GitHub App installation the caller already manages in
// another workspace (OL-928). GitHub's install page cannot record that binding:
// it parks an account that already has the App on its Configure page.
import type { ApiClient } from "./client";
import type { GitHubInstallation, ListGitHubAppInstallationsResponse } from "../types";
import { GitHubInstallationSchema } from "./schemas";
import { parseWithFallback } from "./schema";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import {
  EMPTY_GITHUB_INSTALLATION,
  EMPTY_LIST_GITHUB_APP_INSTALLATIONS_RESPONSE,
  ListGitHubAppInstallationsResponseSchema,
} from "./labrastro-github-schemas";

const labrastroGitHubApi = {
  async listGitHubAppInstallations(
    this: ApiClient,
    workspaceId: string,
  ): Promise<ListGitHubAppInstallationsResponse> {
    const raw = await clientFetch<unknown>(
      this,
      `/api/workspaces/${workspaceId}/github/app-installations`,
    );
    return parseWithFallback(
      raw,
      ListGitHubAppInstallationsResponseSchema,
      EMPTY_LIST_GITHUB_APP_INSTALLATIONS_RESPONSE,
      { endpoint: "GET /api/workspaces/:id/github/app-installations" },
    );
  },

  // Rejections stay ApiErrors with their status: callers word 403 (App
  // credentials missing), 404 (outside the caller's reuse scope) and 422
  // (suspended on GitHub) differently.
  async connectGitHubInstallation(
    this: ApiClient,
    workspaceId: string,
    installationId: number,
  ): Promise<GitHubInstallation> {
    const raw = await clientFetch<unknown>(
      this,
      `/api/workspaces/${workspaceId}/github/installations`,
      { method: "POST", body: JSON.stringify({ installation_id: installationId }) },
    );
    return parseWithFallback(raw, GitHubInstallationSchema, EMPTY_GITHUB_INSTALLATION, {
      endpoint: "POST /api/workspaces/:id/github/installations",
    });
  },
};

export type LabrastroGitHubApi = typeof labrastroGitHubApi;

export function installLabrastroGitHubApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroGitHubApi);
}
