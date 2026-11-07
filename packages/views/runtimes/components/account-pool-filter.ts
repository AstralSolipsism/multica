import type { QuotaAccountPoolState } from "@multica/core/runtimes";
import type { Agent } from "@multica/core/types";

export interface AccountPoolPartition {
  all: QuotaAccountPoolState[];
  serving: QuotaAccountPoolState[];
  idle: QuotaAccountPoolState[];
  /** True only when at least one configured provider matches a reported pool. */
  filtered: boolean;
}

function modelProviderPrefix(model: string | null | undefined): string | null {
  const value = model?.trim() ?? "";
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const provider = value.slice(0, slash).trim();
  return provider || null;
}

function customArgsModel(args: string[]): string | null {
  let model: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === "--model" || arg === "-m") && args[index + 1]) {
      model = args[index + 1]!;
      index++;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    }
  }
  return model;
}

/** Provider prefixes from unarchived agents bound to this runtime. The managed
 *  model field is the canonical shape; custom args cover OMP launch overrides. */
export function servingAccountPoolProviders(
  agents: Agent[],
  runtimeId: string,
): Set<string> {
  const providers = new Set<string>();
  for (const agent of agents) {
    if (agent.runtime_id !== runtimeId || agent.archived_at) continue;
    const model = customArgsModel(agent.custom_args ?? []) ?? agent.model;
    const provider = modelProviderPrefix(model);
    if (provider) providers.add(provider);
  }
  return providers;
}

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
