/** Fixed, readable card geometry shared by the worker and canvas. */
export const DAG_NODE_WIDTH = 248;
export const DAG_NODE_HEIGHT = 116;
export const DAG_GROUP_HEADER_HEIGHT = 76;
export const DAG_GROUP_MIN_WIDTH = 680;
export const DAG_GROUP_HEADER_MAX_WIDTH = 680;
export type DagNodeKindForSize = "issue" | "feature" | "independent";
export function dagNodeSize(kind: DagNodeKindForSize) {
  return {
    width: kind === "issue" ? DAG_NODE_WIDTH : DAG_GROUP_MIN_WIDTH,
    height: kind === "issue" ? DAG_NODE_HEIGHT : DAG_GROUP_HEADER_HEIGHT,
  };
}

export const DAG_GROUP_TB_MIN_WIDTH = 360;
export const DAG_STAGE_HEADER_HEIGHT = 38;
