import type { ZodType } from "zod";
import type { ApiClient } from "./client";
import { ApiError } from "./labrastro-api-error";
import { parseWithFallback } from "./schema";

// Reuse the upstream transport (auth, CSRF retry, workspace headers and HTTP
// errors). A rename or signature change of its TS-private fetch fails here.
export function clientFetch<T>(client: ApiClient, path: string, init?: RequestInit): Promise<T> {
  return (client as unknown as { fetch: ApiClient["fetch"] }).fetch<T>(path, init);
}

/** Reject collisions before installing any method, including inherited names. */
export function installLabrastroApiMethods(
  target: { prototype: object },
  methods: Record<string, (...args: never[]) => unknown>,
): void {
  for (const name of Object.keys(methods)) {
    if (name in target.prototype) {
      throw new Error(`Labrastro API method conflicts with existing method: ${name}`);
    }
  }
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(target.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

// Like upstream parseSearchIndexResponse, reject an unreadable response after
// logging through parseWithFallback. A stable code lets views localize it.
// As in parseWithFallback, T follows the caller's contract: upstream schemas
// can accept wider enum values than their handwritten public types.
export function parseRequiredResponse<T>(raw: unknown, schema: ZodType, endpoint: string): T {
  const parsed = parseWithFallback<T | null>(raw, schema, null, { endpoint });
  if (parsed === null) {
    throw new ApiError(`Unreadable response from ${endpoint}`, 0, "", {
      code: "response_unreadable",
    });
  }
  return parsed;
}

// A successful HTTP status alone does not confirm a write. Preserve OL-118's
// shape validation and operation-specific evidence before resolving.
export function parseConfirmedWrite<T>(
  raw: unknown,
  schema: ZodType<T>,
  endpoint: string,
  confirmed: (value: T) => boolean,
): T {
  const parsed = parseWithFallback<T | null>(raw, schema, null, { endpoint });
  if (parsed === null || !confirmed(parsed)) {
    throw new ApiError(`Unconfirmed response from ${endpoint}`, 0, "", {
      code: "response_unconfirmed",
    });
  }
  return parsed;
}
