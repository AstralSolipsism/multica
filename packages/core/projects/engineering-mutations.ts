// Fork-owned engineering mutation hooks (engineering config, baseline
// propose/adopt/reject, baseline annotation reviews and batches). Re-exported
// from `./mutations` so existing views keep their import paths
// (see docs/engineering/upstream-sync-checklist.md).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ApiClient } from "../api/client";
import { issueKeys } from "../issues/queries";
import { invalidateIssueQueries } from "../issues/invalidation";
import { useWorkspaceId } from "../hooks";
import { engineeringProjectKeys } from "./engineering-queries";

type UpdateProjectEngineeringInput = { projectId: string } &
  Parameters<ApiClient["updateProjectEngineering"]>[2];

export function useUpdateProjectEngineering() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, ...data }: UpdateProjectEngineeringInput) =>
      api.updateProjectEngineering(wsId, projectId, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringAll(wsId, projectId) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringDecisionIssuesAll(wsId, projectId) });
    },
  });
}

type ProposeProjectBaselineInput = { projectId: string } &
  Parameters<ApiClient["proposeProjectBaseline"]>[2];

export function useProposeProjectBaseline() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, ...data }: ProposeProjectBaselineInput) =>
      api.proposeProjectBaseline(wsId, projectId, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringAll(wsId, projectId) });
    },
  });
}

export type DecideProjectBaselineInput = {
  projectId: string;
  revisions: Parameters<ApiClient["decideProjectBaseline"]>[3];
  annotationBatchAction?: "close" | "keep";
};

function useDecideProjectBaseline(action: "adopt" | "reject") {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, revisions, annotationBatchAction }: DecideProjectBaselineInput) =>
      annotationBatchAction
        ? api.decideProjectBaseline(wsId, projectId, action, revisions, { annotationBatchAction })
        : api.decideProjectBaseline(wsId, projectId, action, revisions),
    retry: false,
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringAll(wsId, projectId) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.baselineAnnotationsAll(wsId, projectId) });
      void invalidateIssueQueries(qc, wsId);
      qc.invalidateQueries({ queryKey: issueKeys.timelineAll() });
    },
  });
}

export function useAdoptProjectBaseline() {
  return useDecideProjectBaseline("adopt");
}

export function useRejectProjectBaseline() {
  return useDecideProjectBaseline("reject");
}

export type SubmitProjectBaselineReviewMutationInput = { projectId: string } &
  Parameters<ApiClient["submitProjectBaselineReview"]>[2];

export function useSubmitProjectBaselineReview() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, ...data }: SubmitProjectBaselineReviewMutationInput) =>
      api.submitProjectBaselineReview(wsId, projectId, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.baselineAnnotationsAll(wsId, projectId) });
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineeringAll(wsId, projectId) });
    },
  });
}

export type ResolveProjectBaselineAnnotationsMutationInput = { projectId: string } &
  Parameters<ApiClient["resolveProjectBaselineAnnotations"]>[2];

export function useResolveProjectBaselineAnnotations() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, ...data }: ResolveProjectBaselineAnnotationsMutationInput) =>
      api.resolveProjectBaselineAnnotations(wsId, projectId, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.baselineAnnotationsAll(wsId, projectId) });
    },
  });
}

export interface CloseProjectBaselineAnnotationBatchMutationInput {
  projectId: string;
  batchId: string;
}

export function useCloseProjectBaselineAnnotationBatch() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, batchId }: CloseProjectBaselineAnnotationBatchMutationInput) =>
      api.closeProjectBaselineAnnotationBatch(wsId, projectId, batchId),
    retry: false,
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: engineeringProjectKeys.baselineAnnotationsAll(wsId, projectId) });
    },
  });
}
