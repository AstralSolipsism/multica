// Labrastro fork API. Public methods are mounted by labrastro-api.ts.
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods, parseRequiredResponse } from "./labrastro-api-helpers";
import { ApiError } from "./labrastro-api-error";
import { parseWithFallback } from "./schema";
import { IssueGraphSchema, type IssueGraph, type IssueGraphRequest } from "./issue-graph-schemas";
import { DependencyViewSchema, dependencyMutationToWire, IssueWithDependenciesSchema, type DependencyView, type IssueWithDependencies, type CreateIssueWithDependenciesRequest, type UpdateIssueWithDependenciesRequest } from "./dependency-schemas";

export interface DependencyErrorDetails {
  /** The machine-readable dependency refusal (`dependency_ancestor_conflict`, …). */
  reasonCode: string;
}

// dependencyErrorDetails reads the structured body a `with-dependencies`
// refusal carries ({ error, reason_code } — see
// writeDependencyError in server/internal/handler/issue_dependency.go). It
// returns null for non-dependency errors so callers keep their generic
// handling; a `reason_code` that is not a dependency code is not ours to
// interpret here (dispatchReasonCode already covers the admission family).
export function dependencyErrorDetails(err: unknown): DependencyErrorDetails | null {
  if (!(err instanceof ApiError) || !err.body || typeof err.body !== "object") {
    return null;
  }
  const body = err.body as { reason_code?: unknown };
  if (typeof body.reason_code !== "string" || !body.reason_code.startsWith("dependency_")) {
    return null;
  }
  return { reasonCode: body.reason_code };
}

const labrastroDependencyApi = {
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

  async getIssueDependencies(this: ApiClient, id: string): Promise<DependencyView | null> {
    const raw = await clientFetch<unknown>(this, `/api/issues/${encodeURIComponent(id)}/dependencies`);
    return parseWithFallback<DependencyView | null>(raw, DependencyViewSchema, null, {
      endpoint: "GET /api/issues/:id/dependencies",
    });
  },

  async createIssueWithDependencies(this: ApiClient, data: CreateIssueWithDependenciesRequest): Promise<IssueWithDependencies> {
    const raw = await clientFetch<unknown>(this, "/api/issues/with-dependencies", {
      method: "POST",
      body: JSON.stringify(dependencyMutationToWire(data)),
    });
    return parseRequiredResponse(raw, IssueWithDependenciesSchema, "POST /api/issues/with-dependencies");
  },

  async updateIssueWithDependencies(this: ApiClient, id: string, data: UpdateIssueWithDependenciesRequest): Promise<IssueWithDependencies> {
    const raw = await clientFetch<unknown>(this, `/api/issues/${encodeURIComponent(id)}/with-dependencies`, {
      method: "PATCH",
      body: JSON.stringify(dependencyMutationToWire(data)),
    });
    return parseRequiredResponse(raw, IssueWithDependenciesSchema, "PATCH /api/issues/:id/with-dependencies");
  },
};

export type LabrastroDependencyApi = typeof labrastroDependencyApi;

export function installLabrastroDependencyApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroDependencyApi);
}
