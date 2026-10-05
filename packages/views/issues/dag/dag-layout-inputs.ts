import type { DagProjection } from "./dag-projection";
import type {
  DagLayoutNodeInput,
  DagLayoutGroupInput,
  DagLayoutEdgeInput,
} from "./dag-layout";
import { dagNodeSize } from "./dag-constants";

/** Content fields and server snapshot IDs do not affect geometry. */
export function dagLayoutInputs(projection: DagProjection | null): {
  nodes: DagLayoutNodeInput[];
  groups: DagLayoutGroupInput[];
  edges: DagLayoutEdgeInput[];
} {
  return {
    nodes:
      projection?.nodes.map((node) => ({
        id: node.id,
        ...dagNodeSize(node.kind),
        groupId: node.groupId,
        stage: node.issue?.stage ?? null,
      })) ?? [],
    groups:
      projection?.groups.map(({ id, parentId, collapsed, independent }) => ({
        id,
        parentId,
        collapsed,
        independent,
      })) ?? [],
    edges:
      projection?.edges.map(({ id, source, target }) => ({
        id,
        source,
        target,
      })) ?? [],
  };
}
