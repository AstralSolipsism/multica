export type ViewMode =
  | "board"
  | "list"
  | "table"
  | "gantt"
  | "swimlane"
  | "dag";

/** Renderer capabilities shared by controls, persistence and surface wiring. */
export const VIEW_MODE_CAPABILITIES = {
  board: {
    ordering: true,
    cardProperties: true,
    batchSelection: true,
    graph: false,
  },
  list: {
    ordering: true,
    cardProperties: true,
    batchSelection: true,
    graph: false,
  },
  table: {
    ordering: true,
    cardProperties: false,
    batchSelection: true,
    graph: false,
  },
  swimlane: {
    ordering: true,
    cardProperties: true,
    batchSelection: true,
    graph: false,
  },
  gantt: {
    ordering: true,
    cardProperties: false,
    batchSelection: true,
    graph: false,
  },
  dag: {
    ordering: false,
    cardProperties: true,
    batchSelection: false,
    graph: true,
  },
} as const;

export function visibleViewMode(
  mode: ViewMode,
  { allowGantt, allowDag }: { allowGantt: boolean; allowDag: boolean },
): ViewMode {
  if (!Object.hasOwn(VIEW_MODE_CAPABILITIES, mode)) return "list";
  if (mode === "gantt" && !allowGantt) return "list";
  if (mode === "dag" && !allowDag) return "list";
  return mode;
}
export function availableViewModes(
  availability: Parameters<typeof visibleViewMode>[1],
  order: readonly ViewMode[] = Object.keys(
    VIEW_MODE_CAPABILITIES,
  ) as ViewMode[],
): ViewMode[] {
  return order.filter((mode) => visibleViewMode(mode, availability) === mode);
}
