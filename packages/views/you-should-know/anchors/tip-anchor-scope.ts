import type { Issue } from "@multica/core/types";
import type { TipAnchorScope } from "@multica/core/you-should-know/anchors";

/**
 * Build a summary anchor's scope — the issues the summary covers as
 * id → identifier (OL-193). Feed it the surface's currently loaded issues
 * and memoize at the call site: anchor descriptors must stay referentially
 * stable so the registry is not re-registered on every render.
 */
export function tipAnchorScopeFromIssues(
  issues: readonly Pick<Issue, "id" | "identifier">[],
): TipAnchorScope {
  return Object.fromEntries(
    issues.map((issue) => [issue.id, issue.identifier]),
  );
}
