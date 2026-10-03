import type {
  SkillPackageCandidate,
  SkillPackageItemResult,
  SkillPackagePreview,
} from "@multica/core/api/schemas";

// Pure model for the package import/rescan checklist and the apply report.
// Server defaults and permission hints are honored, never rewritten:
// default_selected drives initial checks, unknown states stay unselectable,
// and can_write only gates the overwrite strategy — rename never requires it.

/** States the user may explicitly check in the preview list. Removed items
 *  are retained automatically, failed/unknown states can only be read. */
export function isCandidateSelectable(candidate: SkillPackageCandidate): boolean {
  return (
    candidate.state === "new" ||
    candidate.state === "adoptable" ||
    candidate.state === "changed" ||
    candidate.state === "unchanged" ||
    candidate.state === "conflict"
  );
}

/** Initial checklist state: exactly the server's default_selected flags,
 *  limited to selectable rows (the schema already strips unknown states). */
export function defaultSelectedPaths(
  candidates: readonly SkillPackageCandidate[],
): Set<string> {
  return new Set(
    candidates
      .filter((c) => c.default_selected && isCandidateSelectable(c))
      .map((c) => c.path),
  );
}

/** Overwrite is only offered when every selected conflicting candidate is
 *  overwritable by the caller. Rename and skip never check can_write. */
export function canApplyOverwrite(
  candidates: readonly SkillPackageCandidate[],
  selectedPaths: ReadonlySet<string>,
): boolean {
  return candidates
    .filter((c) => selectedPaths.has(c.path) && c.state === "conflict")
    .every((c) => c.can_write);
}

/** Whether any selected row is a conflict, so the strategy choice matters. */
export function hasSelectedConflict(
  candidates: readonly SkillPackageCandidate[],
  selectedPaths: ReadonlySet<string>,
): boolean {
  return candidates.some((c) => selectedPaths.has(c.path) && c.state === "conflict");
}

/**
 * Names shared by two or more selected candidates. Known server limitation:
 * in a fresh package these all preview as `new`, and the first apply can
 * import only one — the rest return name_conflict until a re-preview. The UI
 * warns instead of changing the server's conflict strategy.
 */
export function sameNameGroups(
  candidates: readonly SkillPackageCandidate[],
  selectedPaths: ReadonlySet<string>,
): string[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (!selectedPaths.has(c.path)) continue;
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

export function isItemFailure(item: SkillPackageItemResult): boolean {
  return item.status === "failed" || item.status === "unknown";
}

/** The preview token and source identity an apply must echo back. */
export function applyRequestBase(preview: SkillPackagePreview): {
  url: string;
  preview_id: string;
} {
  return { url: preview.source.url, preview_id: preview.preview_id };
}
