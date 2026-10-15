"use client";

import { createContext, useContext } from "react";
import type { DagExternalGroup } from "@multica/core/issues/dag";

/** Canvas-level navigation callbacks, provided by the scene canvas so node
 *  components stay display-only and memo-friendly. */
export interface DagCanvasActions {
  onExternalJump: (group: DagExternalGroup, side: "upstream" | "downstream") => void;
}

export const DagCanvasActionsContext = createContext<DagCanvasActions | null>(null);

export function useDagCanvasActions(): DagCanvasActions | null {
  return useContext(DagCanvasActionsContext);
}
