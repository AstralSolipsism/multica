import type { IssueGraph } from "../../api/issue-graph-schemas";
import { computeDagOverview, type DagOverviewModel } from "./overview";
import { computeDagLine, computeDagFocus, type DagLineModel, type DagFocusModel } from "./detail";
import { createDagModelIndex, type DagModelIndex } from "./model-index";

export type DagModelRequest =
  | { view: "overview"; showCompleted?: boolean; showSatisfiedDependencies?: boolean }
  | { view: "line"; lineId: string }
  | { view: "focus"; issueId: string; showCompleted?: boolean };

export interface DagModels {
  overview: DagOverviewModel | null;
  line: DagLineModel | null;
  focus: DagFocusModel | null;
}

/** A selector belongs to one query scope. Cache only opened lines; constructing
 * an overview never performs redundancy analysis for every line. */
export function createDagModelSelector() {
  let index: DagModelIndex | undefined;
  let overview: DagOverviewModel | undefined;
  const lines = new Map<string, DagLineModel>();
  let lastRequest = "";
  let lastResult: DagModels | undefined;
  return (graph: IssueGraph, request: DagModelRequest): DagModels => {
    const key = JSON.stringify(request);
    if (index?.graph === graph && lastRequest === key && lastResult) return lastResult;
    if (index?.graph !== graph) {
      index = createDagModelIndex(graph, index);
      // Evict removed lines and stale inputs even if those lines aren't open.
      for (const [id, line] of lines) if (index.lineInputs.get(id) !== line.input) lines.delete(id);
    }
    const result: DagModels = { overview: null, line: null, focus: null };
    if (request.view === "overview") {
      overview = computeDagOverview(index, request, overview);
      result.overview = overview;
    } else if (request.view === "line") {
      result.line = computeDagLine(index, request.lineId, lines.get(request.lineId));
      if (result.line) lines.set(request.lineId, result.line);
    } else result.focus = computeDagFocus(index, request.issueId, request.showCompleted);
    lastRequest = key;
    lastResult = result;
    return result;
  };
}
