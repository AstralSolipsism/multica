import { useMemo } from "react";
import { hashKey, useQuery } from "@tanstack/react-query";
import type { IssueTableQuerySpec } from "../../types";
import { issueGraphOptions } from "../graph";
import { createDagModelSelector, type DagModelRequest } from "./selector";

/** Transport boundary for both the existing canvas and the two-level models.
 * Keep graph query keys, schema validation, aborts and realtime invalidation. */
export function useDagGraph(wsId: string, spec: IssueTableQuerySpec, enabled = true) {
  return useQuery({ ...issueGraphOptions(wsId, spec), enabled: !!wsId && enabled });
}

export function useDagModels(wsId: string, spec: IssueTableQuerySpec, request: DagModelRequest, enabled = true) {
  const query = useDagGraph(wsId, spec, enabled);
  const scopeKey = hashKey(issueGraphOptions(wsId, spec).queryKey);
  // The selector cannot reuse data across workspaces, filters or projects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const select = useMemo(() => createDagModelSelector(), [scopeKey]);
  const models = useMemo(() => query.data ? select(query.data, request) : null, [select, query.data, request]);
  return { ...query, models };
}
