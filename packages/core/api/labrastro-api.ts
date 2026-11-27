import { installLabrastroEngineeringApi, type LabrastroEngineeringApi } from "./labrastro-engineering-api";
import { installLabrastroAgentFolderApi, type LabrastroAgentFolderApi } from "./labrastro-agent-folder-api";
import type { ApiClient } from "./client";
import { installLabrastroSkillApi, type LabrastroSkillApi } from "./labrastro-skill-api";
import { installLabrastroMessageDeliveryApi, type LabrastroMessageDeliveryApi } from "./labrastro-message-delivery-api";
import { installLabrastroLarkApi, type LabrastroLarkApi } from "./labrastro-lark-api";
import { installLabrastroQuotaApi, type LabrastroQuotaApi } from "./labrastro-quota-api";
import { installLabrastroYskApi, type LabrastroYskApi } from "./labrastro-ysk-api";
import { installLabrastroGitHubApi, type LabrastroGitHubApi } from "./labrastro-github-api";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import { IssueGraphSchema, type IssueGraph, type IssueGraphRequest } from "./issue-graph-schemas";

// The upstream client's two retained boundary hooks use the same entry point.
export { ApiError } from "./labrastro-api-error";
export { parseRequiredResponse } from "./labrastro-api-helpers";
export { RuntimeListSchema, EMPTY_RUNTIME_LIST } from "./labrastro-quota-schemas";

const labrastroIssueGraphApi = {
  async getIssueGraph(this: ApiClient, wsId: string, request: IssueGraphRequest, options?: { signal?: AbortSignal }): Promise<IssueGraph | null> {
    const search = new URLSearchParams({ query: JSON.stringify(request.query) });
    if (request.focusIssueId) search.set("focus_issue_id", request.focusIssueId);
    const raw = await clientFetch<unknown>(this, `/api/workspaces/${encodeURIComponent(wsId)}/issues/graph?${search}`, {
      signal: options?.signal,
      // Pin both transport scope and cache identity, even across a route switch.
      headers: { "X-Workspace-ID": wsId, "X-Workspace-Slug": "" },
    });
    return parseWithFallback<IssueGraph | null>(raw, IssueGraphSchema, null, {
      endpoint: "GET /api/workspaces/:workspaceId/issues/graph",
    });
  },
};
type LabrastroIssueGraphApi = typeof labrastroIssueGraphApi;

// Infer every public method from its implementation; interface merging keeps
// existing ApiClient imports and mocks typed without duplicating signatures.
declare module "./client" {
  interface ApiClient extends
    LabrastroIssueGraphApi,
    LabrastroAgentFolderApi,
    LabrastroEngineeringApi,
    LabrastroSkillApi,
    LabrastroMessageDeliveryApi,
    LabrastroLarkApi,
    LabrastroQuotaApi,
    LabrastroYskApi,
    LabrastroGitHubApi {}
}

export function installLabrastroApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroIssueGraphApi);
  installLabrastroAgentFolderApi(target);
  installLabrastroEngineeringApi(target);
  installLabrastroSkillApi(target);
  installLabrastroMessageDeliveryApi(target);
  installLabrastroLarkApi(target);
  installLabrastroQuotaApi(target);
  installLabrastroYskApi(target);
  installLabrastroGitHubApi(target);
}

export { EngineeringConfigSchema, EngineeringOverviewSchema, EngineeringUpdatedSchema, WikiPageSchema, WikiTreeSchema, WikiRevisionSchema } from "./labrastro-engineering-schemas";
export type { EngineeringConfig, EngineeringOverview, WikiPage, WikiTree, WikiRevision } from "./labrastro-engineering-schemas";
