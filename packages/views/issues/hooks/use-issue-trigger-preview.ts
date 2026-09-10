"use client";

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import type { IssueDependencyPreview } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import type { IssueAssigneeType, IssueStatus, IssueTriggerPreviewItem } from "@multica/core/types";
import type {
  CreateIssueWithDependenciesRequest,
  UpdateIssueWithDependenciesRequest,
} from "@multica/core/api";

export interface UseIssueTriggerPreviewParams {
  /** Existing issues to evaluate (single assign/status or batch). */
  issueIds?: string[];
  /** Preview a not-yet-persisted issue from assignee/status (create modal). */
  isCreate?: boolean;
  assigneeType?: IssueAssigneeType | null;
  assigneeId?: string | null;
  status?: IssueStatus;
  /**
   * The entire exact compound create/update body the caller intends to
   * submit (OL-41). The server signs its confirmation challenge over this
   * body, so it belongs to the query identity: change any field and the
   * preview — and any confirmation it issued — no longer applies.
   */
  mutation?: CreateIssueWithDependenciesRequest | UpdateIssueWithDependenciesRequest;
  /** Caller gate — e.g. only fetch while a picker/modal is open. */
  enabled?: boolean;
}

export interface UseIssueTriggerPreviewResult {
  triggers: IssueTriggerPreviewItem[];
  /**
   * Per-issue dependency refusals with their projection and, for an
   * authenticated human, the one-shot confirmation challenge. `null` means
   * the server sent no diagnostics (older server or a request without a
   * `mutation`) — unknown, never "all prerequisites satisfied".
   */
  blocked: IssueDependencyPreview[] | null;
  totalCount: number;
  isLoading: boolean;
  /**
   * True while the previous inputs' answer is being shown during a refetch
   * (keepPreviousData). Any `confirmation` inside `blocked` was signed for
   * THOSE inputs — submitting it against the current mutation would be
   * replaying a stale challenge, so override actions must stay disabled.
   */
  isPlaceholderData: boolean;
  /** Freshness token: changes when a non-placeholder answer lands, so a
   *  consumer can settle "refreshing confirmation" notices exactly then. */
  dataUpdatedAt: number;
  refetch: () => void;
}

const EMPTY: IssueTriggerPreviewItem[] = [];

/** Deterministic serialization for the query identity: object keys sorted
 *  recursively so a semantically identical body always maps to one cache
 *  entry. `blockedBy` is a set, so its copy is sorted — the server's payload
 *  digest treats it as the replacement set it is. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

function canonicalMutation(
  mutation: UseIssueTriggerPreviewParams["mutation"],
): Record<string, unknown> | undefined {
  if (!mutation) return undefined;
  const canonical = canonicalize(mutation) as Record<string, unknown>;
  if (Array.isArray(canonical.blockedBy)) {
    canonical.blockedBy = [...canonical.blockedBy].sort();
  }
  return canonical;
}

function previewSignature(params: UseIssueTriggerPreviewParams): string {
  return JSON.stringify({
    ids: [...(params.issueIds ?? [])].sort(),
    create: params.isCreate ?? false,
    at: params.assigneeType ?? null,
    aid: params.assigneeId ?? null,
    status: params.status ?? null,
    mutation: canonicalMutation(params.mutation) ?? null,
  });
}

/** Reads the unified backend predicate via POST /api/issues/preview-trigger so
 *  the four entry points never re-implement "will this start a run" (MUL-3375).
 *
 *  With a `mutation` the response also carries dependency diagnostics: blocked
 *  targets, their prerequisite projection, and — for a human JWT only — the
 *  signed confirmation a later compound write may echo as `dependencyOverride`.
 *
 *  The verdict changes only with the inputs (assignee / status / mutation), so
 *  the query refetches solely on signature change — it is deliberately NOT
 *  invalidated by WS task events. The assign source (create / assignee change)
 *  cancels existing tasks before enqueuing, so its verdict can't shift from a
 *  task event at all; the status source's pending dedup could, but the preview
 *  is advisory and the write path re-evaluates authoritatively, so a rare stale
 *  status label is harmless — far better than refetching every mounted preview
 *  on every workspace task event (the source of the visible flicker, MUL-3375).
 *
 *  Mirrors the comment-trigger preview's data handling: keepPreviousData so an
 *  input switch swaps the answer in place instead of collapsing, and only the
 *  very first load (no prior data) counts as loading. */
export function useIssueTriggerPreview(
  params: UseIssueTriggerPreviewParams,
): UseIssueTriggerPreviewResult {
  const hasTarget =
    (!!params.assigneeType && !!params.assigneeId) ||
    !!params.status ||
    !!params.mutation ||
    (params.isCreate ?? false);
  const enabled = (params.enabled ?? true) && hasTarget;

  const signature = useMemo(() => previewSignature(params), [params]);

  const previewQuery = useQuery({
    queryKey: issueKeys.issueTriggerPreview(signature),
    queryFn: () =>
      api.previewIssueTrigger({
        issueIds: params.issueIds,
        isCreate: params.isCreate,
        assigneeType: params.assigneeType,
        assigneeId: params.assigneeId,
        status: params.status,
        mutation: params.mutation,
      }),
    enabled,
    retry: false,
    staleTime: 0,
    // Keep the prior verdict visible while a new signature (assignee/status
    // switch) refetches, so the hint swaps in place rather than collapsing.
    placeholderData: keepPreviousData,
  });

  const triggers = previewQuery.data?.triggers ?? EMPTY;
  return {
    triggers,
    blocked: previewQuery.data?.blocked ?? null,
    totalCount: previewQuery.data?.total_count ?? 0,
    // Only the first load (no prior data) is "loading"; a background/placeholder
    // refetch is not, so reveal animations gated on this never collapse mid-fetch.
    isLoading: enabled && previewQuery.isLoading,
    isPlaceholderData: previewQuery.isPlaceholderData,
    dataUpdatedAt: previewQuery.dataUpdatedAt,
    refetch: () => {
      void previewQuery.refetch();
    },
  };
}
