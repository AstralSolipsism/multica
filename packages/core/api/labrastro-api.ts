import type { ApiClient } from "./client";
import { installLabrastroSkillApi, type LabrastroSkillApi } from "./labrastro-skill-api";
import { installLabrastroMessageDeliveryApi, type LabrastroMessageDeliveryApi } from "./labrastro-message-delivery-api";
import { installLabrastroDependencyApi, type LabrastroDependencyApi } from "./labrastro-dependency-api";
import { installLabrastroLarkApi, type LabrastroLarkApi } from "./labrastro-lark-api";
import { installLabrastroQuotaApi, type LabrastroQuotaApi } from "./labrastro-quota-api";

// The upstream client's three retained boundary hooks use the same entry point.
export { ApiError } from "./labrastro-api-error";
export { parseRequiredResponse } from "./labrastro-api-helpers";
export { IssueBatchUpdateSchema, type IssueBatchUpdateResult } from "./dependency-schemas";
export { LarkInstallationsSchema } from "../lark/schema";
export { RuntimeListSchema, EMPTY_RUNTIME_LIST } from "./labrastro-quota-schemas";
export { dependencyErrorDetails, type DependencyErrorDetails } from "./labrastro-dependency-api";

// Infer every public method from its implementation; interface merging keeps
// existing ApiClient imports and mocks typed without duplicating signatures.
declare module "./client" {
  interface ApiClient extends
    LabrastroSkillApi,
    LabrastroMessageDeliveryApi,
    LabrastroDependencyApi,
    LabrastroLarkApi,
    LabrastroQuotaApi {}
}

export function installLabrastroApi(target: { prototype: ApiClient }): void {
  installLabrastroSkillApi(target);
  installLabrastroMessageDeliveryApi(target);
  installLabrastroDependencyApi(target);
  installLabrastroLarkApi(target);
  installLabrastroQuotaApi(target);
}
