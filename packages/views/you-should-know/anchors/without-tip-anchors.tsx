"use client";

import type { ReactNode } from "react";
import { TipAnchorRegistryProvider } from "./tip-anchor-context";

/**
 * Keeps a subtree out of the page's tip anchors (OL-197). The inbox shows no
 * tips (OL-187 §2), yet it embeds the full issue detail beside its list, and
 * that detail's header chip, sub-issue chip and sub-issue rows would register
 * like on the issue page. Inside this wrapper they register nowhere — no
 * bubble, no dots — while the rest of the page keeps its anchors. The issue's
 * archive section is not an anchor and stays.
 */
export function WithoutTipAnchors({ children }: { children: ReactNode }) {
  return <TipAnchorRegistryProvider registry={null}>{children}</TipAnchorRegistryProvider>;
}
