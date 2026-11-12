// Fork-owned engineering mutation hooks (engineering config and the baseline
// wiki write surface). Re-exported from `./mutations` so existing views keep
// their import paths (see docs/engineering/upstream-sync-checklist.md).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ApiClient } from "../api/client";
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

function useInvalidateWiki() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return (projectId: string) => {
    qc.invalidateQueries({ queryKey: engineeringProjectKeys.wikiRoot(wsId, projectId) });
    qc.invalidateQueries({ queryKey: engineeringProjectKeys.engineering(wsId, projectId) });
  };
}

type CreateWikiPageInput = { projectId: string } & Parameters<ApiClient["createProjectWikiPage"]>[2];

export function useCreateWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, ...data }: CreateWikiPageInput) =>
      api.createProjectWikiPage(wsId, projectId, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}

type WriteWikiPageInput = { projectId: string; page: string } &
  Parameters<ApiClient["writeProjectWikiPage"]>[3];

export function useWriteWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, page, ...data }: WriteWikiPageInput) =>
      api.writeProjectWikiPage(wsId, projectId, page, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}

type RenameWikiPageInput = { projectId: string; page: string } &
  Parameters<ApiClient["renameProjectWikiPage"]>[3];

export function useRenameWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, page, ...data }: RenameWikiPageInput) =>
      api.renameProjectWikiPage(wsId, projectId, page, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}

type MoveWikiPageInput = { projectId: string; page: string } &
  Parameters<ApiClient["moveProjectWikiPage"]>[3];

export function useMoveWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, page, ...data }: MoveWikiPageInput) =>
      api.moveProjectWikiPage(wsId, projectId, page, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}

type ArchiveWikiPageInput = { projectId: string; page: string } &
  Parameters<ApiClient["archiveProjectWikiPage"]>[3];

export function useArchiveWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, page, ...data }: ArchiveWikiPageInput) =>
      api.archiveProjectWikiPage(wsId, projectId, page, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}

type RestoreWikiPageInput = { projectId: string; page: string } &
  Parameters<ApiClient["restoreProjectWikiPage"]>[3];

export function useRestoreWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, page, ...data }: RestoreWikiPageInput) =>
      api.restoreProjectWikiPage(wsId, projectId, page, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}

type RollbackWikiPageInput = { projectId: string; page: string } &
  Parameters<ApiClient["rollbackProjectWikiPage"]>[3];

export function useRollbackWikiPage() {
  const wsId = useWorkspaceId();
  const invalidate = useInvalidateWiki();
  return useMutation({
    mutationFn: ({ projectId, page, ...data }: RollbackWikiPageInput) =>
      api.rollbackProjectWikiPage(wsId, projectId, page, data),
    retry: false,
    onSettled: (_data, _error, { projectId }) => invalidate(projectId),
  });
}
