import {
  servingAccountPoolProviders,
  type QuotaAccountPoolState,
} from "@multica/core/runtimes";
import type { Agent } from "@multica/core/types";

export interface AccountPoolPartition {
  all: QuotaAccountPoolState[];
  serving: QuotaAccountPoolState[];
  idle: QuotaAccountPoolState[];
  /** True only when at least one configured provider matches a reported pool. */
  filtered: boolean;
}

export { servingAccountPoolProviders };

/** Empty prefix sets and prefix sets with no reported intersection both fall
 *  back to the full pool list, avoiding an empty quota surface. */
export function partitionAccountPools(
  pools: QuotaAccountPoolState[],
  agents: Agent[],
  runtimeId: string,
): AccountPoolPartition {
  const providers = servingAccountPoolProviders(agents, runtimeId);
  const serving = pools.filter((pool) => providers.has(pool.id));
  if (serving.length === 0) {
    return { all: pools, serving: pools, idle: [], filtered: false };
  }
  const servingIds = new Set(serving.map((pool) => pool.id));
  return {
    all: pools,
    serving,
    idle: pools.filter((pool) => !servingIds.has(pool.id)),
    filtered: true,
  };
}

const PROVIDER_NAMES: Record<string, string> = {
  "kimi-code": "Kimi Code",
  anthropic: "Claude",
  "openai-codex": "Codex",
  zai: "Z.AI",
};

export function accountPoolProviderLabel(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function accountPoolLogoProvider(provider: string): string {
  switch (provider) {
    case "kimi-code":
      return "kimi";
    case "anthropic":
      return "claude";
    case "openai-codex":
      return "codex";
    default:
      return provider;
  }
}

export function accountPoolNeedsRelogin(pool: QuotaAccountPoolState): boolean {
  return pool.accounts.length > 0 &&
    pool.accounts.every((account) => account.status === "disabled");
}
