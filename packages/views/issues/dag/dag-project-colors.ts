/** Stable project colors for the DAG overview's left color bar. The graph
 *  endpoint only returns project id + title, so the assignment is a content
 *  hash — the same project keeps the same color across sessions and filters,
 *  and project-less cards get a neutral bar. */

const DAG_PROJECT_PALETTE = [
  "#4f8ef7", // blue
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#f4735c", // coral
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#14b8a6", // teal
  "#06b6d4", // cyan
] as const;

export const DAG_PROJECT_NEUTRAL = "#94a3b8";

function hashProjectId(id: string): number {
  // FNV-1a 32-bit: stable across runs and cheap for short ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function dagProjectColor(projectId: string | null | undefined): string {
  if (!projectId) return DAG_PROJECT_NEUTRAL;
  return DAG_PROJECT_PALETTE[hashProjectId(projectId) % DAG_PROJECT_PALETTE.length]!;
}
