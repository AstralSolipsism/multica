"use client";

import { createContext, use } from "react";
import type { TipAnchorRegistry } from "@multica/core/you-should-know/anchors";

/**
 * Per-page tip anchor registry (OL-193). The page-level You-should-know
 * provider creates the instance and hands it down here; anchor hosts
 * (`AgentAvatarStack` via `useTipAnchor`) register into it.
 *
 * Null — the default, and what the provider passes while the feature is off
 * for this viewer — makes the whole feature inert: anchors do not register
 * and nothing renders differently.
 */
const TipAnchorRegistryContext = createContext<TipAnchorRegistry | null>(null);

export function TipAnchorRegistryProvider({
  registry,
  children,
}: {
  registry: TipAnchorRegistry | null;
  children: React.ReactNode;
}) {
  return (
    <TipAnchorRegistryContext.Provider value={registry}>
      {children}
    </TipAnchorRegistryContext.Provider>
  );
}

export function useTipAnchorRegistry(): TipAnchorRegistry | null {
  return use(TipAnchorRegistryContext);
}
