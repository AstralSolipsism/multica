// Labrastro fork API. Public methods are mounted by labrastro-api.ts.
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import { GlmQuotaStatusSchema, type GlmQuotaStatus } from "./labrastro-quota-schemas";

const labrastroQuotaApi = {
  async getGlmQuota(this: ApiClient): Promise<GlmQuotaStatus> {
    const raw = await clientFetch<unknown>(this, "/api/glm-quota");
    return parseWithFallback<GlmQuotaStatus>(raw, GlmQuotaStatusSchema, { enabled: false }, {
      endpoint: "GET /api/glm-quota",
    });
  },
};

export type LabrastroQuotaApi = typeof labrastroQuotaApi;

export function installLabrastroQuotaApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroQuotaApi);
}
