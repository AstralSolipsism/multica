/**
 * Canvas node geometry, engine-free by design: `dag-view.tsx` reaches these
 * constants without importing the React Flow node module or Dagre, keeping
 * both engines out of the first-load bundle (only the lazy canvas chunk and
 * the layout worker reference them).
 */

export const DAG_NODE_WIDTH = 232;
export const DAG_NODE_HEIGHT = 84;

export type DagNodeKindForSize = "issue" | "project" | "feature";

export function dagNodeSize(kind: DagNodeKindForSize): {
  width: number;
  height: number;
} {
  return {
    width: DAG_NODE_WIDTH,
    height: kind === "issue" ? DAG_NODE_HEIGHT : DAG_NODE_HEIGHT + 10,
  };
}
