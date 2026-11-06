import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CreateQuotaSourceInput, UpdateQuotaSourceInput } from "../api/schemas";
import { quotaSourceKeys } from "./queries";

function invalidateQuotaSources(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: quotaSourceKeys.all() });
  void qc.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "runtimes" && query.queryKey[2] === "quota-sources",
  });
}

export function useCreateQuotaSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateQuotaSourceInput) => api.createQuotaSource(input),
    onSettled: () => invalidateQuotaSources(qc),
  });
}

export function useUpdateQuotaSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateQuotaSourceInput }) =>
      api.updateQuotaSource(id, input),
    onSettled: () => invalidateQuotaSources(qc),
  });
}

export function useDeleteQuotaSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteQuotaSource(id),
    onSettled: () => invalidateQuotaSources(qc),
  });
}

export function useRefreshQuotaSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.refreshQuotaSource(id),
    onSettled: () => invalidateQuotaSources(qc),
  });
}
