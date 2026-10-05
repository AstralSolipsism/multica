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
    direction: false,
  },
  list: {
    ordering: true,
    cardProperties: true,
    batchSelection: true,
    graph: false,
    direction: false,
  },
  table: {
    ordering: true,
    cardProperties: false,
    batchSelection: true,
    graph: false,
    direction: false,
  },
  swimlane: {
    ordering: true,
    cardProperties: true,
    batchSelection: true,
    graph: false,
    direction: false,
  },
  gantt: {
    ordering: true,
    cardProperties: false,
    batchSelection: true,
    graph: false,
    direction: false,
  },
  dag: {
    ordering: false,
    cardProperties: false,
    batchSelection: false,
    graph: true,
    direction: true,
  },
} as const;

export function visibleViewMode(
  mode: ViewMode,
  { allowGantt, allowDag }: { allowGantt: boolean; allowDag: boolean },
): ViewMode {
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
