import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ApiClient } from "../api/client";
import { projectKeys } from "./queries";
import { issueKeys } from "../issues/queries";
import { invalidateIssueQueries } from "../issues/invalidation";
import { useWorkspaceId } from "../hooks";
import { useRecentContextStore } from "../chat/recent-context-store";
import { clearIssueSurfaceViewState } from "../issues/stores/surface-view-store";
import { issueScopeKey } from "../issues/surface/scope";
import type { Project, CreateProjectRequest, UpdateProjectRequest, ListProjectsResponse } from "../types";

export function useCreateProject() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateProjectRequest) => api.createProject(data),
    onSuccess: (newProject) => {
      qc.setQueryData<ListProjectsResponse>(projectKeys.list(wsId), (old) =>
        old && !old.projects.some((p) => p.id === newProject.id)
          ? { ...old, projects: [...old.projects, newProject], total: old.total + 1 }
          : old,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectKeys.list(wsId) });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateProjectRequest) =>
      api.updateProject(id, data),
    onMutate: ({ id, ...data }) => {
      qc.cancelQueries({ queryKey: projectKeys.list(wsId) });
      const prevList = qc.getQueryData<ListProjectsResponse>(projectKeys.list(wsId));
      const prevDetail = qc.getQueryData<Project>(projectKeys.detail(wsId, id));
      qc.setQueryData<ListProjectsResponse>(projectKeys.list(wsId), (old) =>
        old ? { ...old, projects: old.projects.map((p) => (p.id === id ? { ...p, ...data } : p)) } : old,
      );
      qc.setQueryData<Project>(projectKeys.detail(wsId, id), (old) =>
        old ? { ...old, ...data } : old,
      );
      return { prevList, prevDetail, id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(projectKeys.list(wsId), ctx.prevList);
      if (ctx?.prevDetail) qc.setQueryData(projectKeys.detail(wsId, ctx.id), ctx.prevDetail);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(wsId, vars.id) });
      qc.invalidateQueries({ queryKey: projectKeys.list(wsId) });
      // A project's status is a filter dimension of the issue table, so
      // changing it moves issues in and out of a filtered window. Nothing
      // in the issue payload changes, so only this invalidation can
      // refresh it — the global staleTime is Infinity.
      if ("status" in vars) {
        qc.invalidateQueries({ queryKey: issueKeys.tableAll(wsId) });
      }
    },
  });
}

export class ProjectDeletionOfflineError extends Error {
  constructor() {
    super("You're offline. Reconnect and try deleting again.");
    this.name = "ProjectDeletionOfflineError";
  }
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    // Fail offline deletions instead of queuing a destructive action behind a modal.
    networkMode: "always",
    retry: false,
    mutationFn: (id: string) => {
      if (!onlineManager.isOnline()) throw new ProjectDeletionOfflineError();
      return api.deleteProject(id);
    },
    onSuccess: async (_data, id) => {
      // Reads started during DELETE may still contain the removed project.
      await qc.cancelQueries({ queryKey: projectKeys.list(wsId) });
      qc.setQueryData<ListProjectsResponse>(projectKeys.list(wsId), (old) =>
        old && old.projects.some((p) => p.id === id)
          ? { ...old, projects: old.projects.filter((p) => p.id !== id), total: old.total - 1 }
          : old,
      );
      qc.removeQueries({ queryKey: projectKeys.detail(wsId, id) });
      qc.removeQueries({ queryKey: projectKeys.engineeringAll(wsId, id) });
      useRecentContextStore.getState().forgetContext(wsId, { type: "project", id });
      clearIssueSurfaceViewState(issueScopeKey({ type: "project", projectId: id }));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: projectKeys.list(wsId) });
      // Deleting a project removes its status from the workspace, so a table
      // window filtered on that status still holds its issues. The realtime
      // event invalidates too, but a delivery gap must not leave the window
      // wrong forever — the global staleTime is Infinity.
      qc.invalidateQueries({ queryKey: issueKeys.tableAll(wsId) });
    },
  });
}

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
      qc.invalidateQueries({ queryKey: projectKeys.engineeringAll(wsId, projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.engineeringDecisionIssuesAll(wsId, projectId) });
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
      qc.invalidateQueries({ queryKey: projectKeys.engineeringAll(wsId, projectId) });
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
      qc.invalidateQueries({ queryKey: projectKeys.engineeringAll(wsId, projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.baselineAnnotationsAll(wsId, projectId) });
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
      qc.invalidateQueries({ queryKey: projectKeys.baselineAnnotationsAll(wsId, projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.engineeringAll(wsId, projectId) });
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
      qc.invalidateQueries({ queryKey: projectKeys.baselineAnnotationsAll(wsId, projectId) });
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
      qc.invalidateQueries({ queryKey: projectKeys.baselineAnnotationsAll(wsId, projectId) });
    },
  });
}
