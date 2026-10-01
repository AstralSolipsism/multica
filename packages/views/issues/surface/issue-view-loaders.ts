import { lazy } from "react";

function once<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load().catch((error) => { pending = undefined; throw error; }));
}

const loaders = {
  board: once(() => import("../components/board-view").then((module) => ({ default: module.BoardView }))),
  table: once(() => import("../components/table-view").then((module) => ({ default: module.TableView }))),
  gantt: once(() => import("../components/gantt-view").then((module) => ({ default: module.GanttView }))),
  swimlane: once(() => import("../components/swimlane-view").then((module) => ({ default: module.SwimLaneView }))),
};

export const BoardView = lazy(loaders.board);
export const TableView = lazy(loaders.table);
export const GanttView = lazy(loaders.gantt);
export const SwimLaneView = lazy(loaders.swimlane);

export function preloadIssueView(mode: string) {
  if (Object.hasOwn(loaders, mode)) {
    void loaders[mode as keyof typeof loaders]().catch(() => undefined);
  }
}
