// Labrastro fork API. Public methods are mounted by labrastro-api.ts.
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import {
  EMPTY_QUOTA_SOURCE_LIST,
  EMPTY_WORKSPACE_QUOTA_SOURCE_LIST,
  GlmQuotaStatusSchema,
  QuotaSourceListResponseSchema,
  QuotaSourceSchema,
  WorkspaceQuotaSourceListResponseSchema,
  type CreateQuotaSourceInput,
  type GlmQuotaStatus,
  type QuotaSource,
  type QuotaSourceListResponse,
  type UpdateQuotaSourceInput,
  type WorkspaceQuotaSourceListResponse,
} from "./labrastro-quota-schemas";
import { parseConfirmedWrite } from "./labrastro-api-helpers";

const labrastroQuotaApi = {
  async getGlmQuota(this: ApiClient): Promise<GlmQuotaStatus> {
    const raw = await clientFetch<unknown>(this, "/api/glm-quota");
    return parseWithFallback<GlmQuotaStatus>(raw, GlmQuotaStatusSchema, { enabled: false }, {
      endpoint: "GET /api/glm-quota",
    });
  },

  async listQuotaSources(this: ApiClient): Promise<QuotaSourceListResponse> {
    const raw = await clientFetch<unknown>(this, "/api/me/quota-sources");
    return parseWithFallback(raw, QuotaSourceListResponseSchema, EMPTY_QUOTA_SOURCE_LIST, {
      endpoint: "GET /api/me/quota-sources",
    });
  },

  async listWorkspaceQuotaSources(
    this: ApiClient,
    wsId: string,
  ): Promise<WorkspaceQuotaSourceListResponse> {
    const raw = await clientFetch<unknown>(
      this,
      `/api/runtimes/quota-sources?workspace_id=${encodeURIComponent(wsId)}`,
    );
    return parseWithFallback(
      raw,
      WorkspaceQuotaSourceListResponseSchema,
      EMPTY_WORKSPACE_QUOTA_SOURCE_LIST,
      { endpoint: "GET /api/runtimes/quota-sources" },
    );
  },

  async createQuotaSource(
    this: ApiClient,
    input: CreateQuotaSourceInput,
  ): Promise<QuotaSource> {
    const raw = await clientFetch<unknown>(this, "/api/me/quota-sources", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return parseConfirmedWrite(
      raw,
      QuotaSourceSchema,
      "POST /api/me/quota-sources",
      (source) => source.id.length > 0,
    );
  },

  async updateQuotaSource(
    this: ApiClient,
    id: string,
    input: UpdateQuotaSourceInput,
  ): Promise<QuotaSource> {
    const raw = await clientFetch<unknown>(
      this,
      `/api/me/quota-sources/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return parseConfirmedWrite(
      raw,
      QuotaSourceSchema,
      "PATCH /api/me/quota-sources/:id",
      (source) => source.id === id,
    );
  },

  async deleteQuotaSource(this: ApiClient, id: string): Promise<void> {
    await clientFetch(this, `/api/me/quota-sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async refreshQuotaSource(this: ApiClient, id: string): Promise<QuotaSource> {
    const raw = await clientFetch<unknown>(
      this,
      `/api/me/quota-sources/${encodeURIComponent(id)}/refresh`,
      { method: "POST" },
    );
    return parseConfirmedWrite(
      raw,
      QuotaSourceSchema,
      "POST /api/me/quota-sources/:id/refresh",
      (source) => source.id === id,
    );
  },
};

export type LabrastroQuotaApi = typeof labrastroQuotaApi;

export function installLabrastroQuotaApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroQuotaApi);
}
