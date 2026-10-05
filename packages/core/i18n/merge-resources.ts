/** Merge a fork-owned overlay without mutating the upstream resource bundle. */
export function mergeResources<T extends Record<string, unknown>>(
  base: T,
  overrides: Record<string, unknown>,
): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const original = base[key];
    merged[key] = isRecord(original) && isRecord(value)
      ? mergeResources(original, value)
      : value;
  }
  return merged as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
