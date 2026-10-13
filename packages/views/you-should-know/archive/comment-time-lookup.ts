import type { TimelineEntry } from "@multica/core/types";

/**
 * Build the archive group-label time source (OL-346): comment creation time
 * by comment id, from the issue's timeline. The timeline is fetched in full,
 * so anchor comments resolve here; the archive section falls back to a
 * group's earliest tip time for ids missing from the lookup.
 *
 * Labels must agree with the comment card, so this reads `created_at` —
 * never `updated_at`, which an edit bumps.
 */
export function commentTimeLookup(
  timeline: readonly TimelineEntry[],
): (commentId: string) => string | undefined {
  const times = new Map<string, string>();
  for (const entry of timeline) {
    if (entry.type === "comment") times.set(entry.id, entry.created_at);
  }
  return (commentId) => times.get(commentId);
}
