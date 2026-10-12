import { useDagGraph } from "./use-dag-data";
import type { IssueScope } from "../surface/scope";
import type { IssueTableQuerySpec } from "../../types";
import {
  VIEW_MODE_CAPABILITIES,
  type ViewMode,
} from "../surface/view-mode";

const UNSUPPORTED_SCOPE_SPEC: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "position", direction: "asc" },
};
export function supportsDagScope(scope: IssueScope) {
  return scope.type === "workspace" || scope.type === "project";
}
export function useDagSurfaceGraph(
  wsId: string,
  scope: IssueScope,
  mode: ViewMode,
  spec: IssueTableQuerySpec,
  filtersUnresolved: boolean,
) {
  const supported = supportsDagScope(scope);
  const enabled = VIEW_MODE_CAPABILITIES[mode].graph && supported;
  const query = useDagGraph(wsId, supported ? spec : UNSUPPORTED_SCOPE_SPEC, enabled && !filtersUnresolved);
  return {
    graph: {
      data: query.data,
      isPending: enabled && query.isPending,
      isError: query.isError,
      error: query.error,
      refetch: () => {
        void query.refetch();
      },
    },
    isRefreshing: enabled && query.isFetching && !query.isPending,
  };
}
