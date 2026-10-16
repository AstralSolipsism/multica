/** Stable project colors for the DAG overview's left color bar. The graph
 *  endpoint only returns project id + title, so the assignment is a content
 *  hash — the same project keeps the same color across sessions and filters,
 *  and project-less cards get a neutral bar. Each entry carries a light and a
 *  dark variant so the bar stays readable in both themes. */

const DAG_PROJECT_PALETTE: readonly { light: string; dark: string }[] = [
  { light: "#4f8ef7", dark: "#6ba3f8" }, // blue
  { light: "#8b5cf6", dark: "#a78bfa" }, // violet
  { light: "#d946ef", dark: "#e879f9" }, // fuchsia
  { light: "#ec4899", dark: "#f472b6" }, // pink
  { light: "#f4735c", dark: "#fb8a76" }, // coral
  { light: "#f59e0b", dark: "#fbbf24" }, // amber
  { light: "#84cc16", dark: "#a3e635" }, // lime
  { light: "#10b981", dark: "#34d399" }, // emerald
  { light: "#14b8a6", dark: "#2dd4bf" }, // teal
  { light: "#06b6d4", dark: "#22d3ee" }, // cyan
] as const;

export const DAG_PROJECT_NEUTRAL = { light: "#94a3b8", dark: "#64748b" } as const;

function hashProjectId(id: string): number {
  // FNV-1a 32-bit: stable across runs and cheap for short ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function dagProjectColor(
  projectId: string | null | undefined,
  dark = false,
): string {
  const pair = projectId
    ? DAG_PROJECT_PALETTE[hashProjectId(projectId) % DAG_PROJECT_PALETTE.length]!
    : DAG_PROJECT_NEUTRAL;
  return dark ? pair.dark : pair.light;
}
