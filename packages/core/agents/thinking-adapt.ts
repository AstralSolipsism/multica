import type { RuntimeDevice, RuntimeModelThinkingLevel } from "../types";

export const THINKING_LEVEL_ADAPT = "_adapt";
export const THINKING_ADAPT_CAPABILITY = "thinking-adapt-v1";

const NON_CANDIDATE_LEVELS = new Set(["auto", "off", "none", "disabled"]);

export function adaptThinkingCandidates(
  levels: readonly RuntimeModelThinkingLevel[] | null | undefined,
): RuntimeModelThinkingLevel[] {
  return (levels ?? []).filter((level) => !NON_CANDIDATE_LEVELS.has(level.value));
}

export function hasAdaptThinkingCandidates(
  levels: readonly RuntimeModelThinkingLevel[] | null | undefined,
): boolean {
  return adaptThinkingCandidates(levels).length >= 2;
}

export function runtimeSupportsThinkingAdapt(
  runtime: Pick<RuntimeDevice, "metadata"> | null | undefined,
): boolean {
  const capabilities = runtime?.metadata?.capabilities;
  return (
    Array.isArray(capabilities) &&
    capabilities.includes(THINKING_ADAPT_CAPABILITY)
  );
}
