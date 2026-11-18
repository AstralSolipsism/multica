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
 *  back to the full pool list. Partition before hiding contentless pools so an
 *  empty serving pool never promotes idle pools into the serving surface. */
export function partitionAccountPools(
  pools: QuotaAccountPoolState[],
  agents: Agent[],
  runtimeId: string,
): AccountPoolPartition {
  const providers = servingAccountPoolProviders(agents, runtimeId);
  const serving = pools.filter((pool) => providers.has(pool.id));
  if (serving.length === 0) {
    const visible = pools.filter(accountPoolHasQuotaContent);
    return { all: visible, serving: visible, idle: [], filtered: false };
  }
  const servingIds = new Set(serving.map((pool) => pool.id));
  return {
    all: pools.filter(accountPoolHasQuotaContent),
    serving: serving.filter(accountPoolHasQuotaContent),
    idle: pools.filter((pool) => !servingIds.has(pool.id) && accountPoolHasQuotaContent(pool)),
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

export function accountPoolNeedsRelogin(pool: QuotaAccountPoolState): boolean {
  return pool.accounts.length > 0 &&
    pool.accounts.every((account) => account.status === "disabled");
}

export function accountPoolHasQuotaContent(pool: QuotaAccountPoolState): boolean {
  return pool.windows.length > 0 || pool.exhausted || accountPoolNeedsRelogin(pool);
}
