import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { messageSourceKeys } from "./source-queries";
import { useWorkspaceId } from "../hooks";
import type {
  ApproveMessageSourceTargetRequest,
  SaveMessageSourceRouteRequest,
} from "../types";

// No optimistic updates on this surface: a route only takes effect once the
// server commits it (revision-guarded, approval-checked, target-verified),
// and a "saved" route that the server rejected must never appear as saved.
// Every mutation settles by invalidating the authoritative queries.

export function useCreateMessageSourceRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: SaveMessageSourceRouteRequest) => api.createMessageSourceRoute(data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.routesAll(wsId) });
    },
  });
}

export function useUpdateMessageSourceRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      routeId,
      ...data
    }: { routeId: string } & SaveMessageSourceRouteRequest) =>
      api.updateMessageSourceRoute(routeId, data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.routesAll(wsId) });
    },
  });
}

export function useSetMessageSourceRouteEnabled() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      routeId,
      enabled,
      expectedRevision,
    }: {
      routeId: string;
      enabled: boolean;
      expectedRevision: number;
    }) => api.setMessageSourceRouteEnabled(routeId, enabled, expectedRevision),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.routesAll(wsId) });
      // Disabling cancels queued sends; enabling restarts eligibility.
      qc.invalidateQueries({ queryKey: messageSourceKeys.deliveriesAll(wsId) });
    },
  });
}

export function useDeleteMessageSourceRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ routeId }: { routeId: string }) => api.deleteMessageSourceRoute(routeId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.routesAll(wsId) });
      qc.invalidateQueries({ queryKey: messageSourceKeys.deliveriesAll(wsId) });
    },
  });
}

// Test-send runs the real send path synchronously; the returned delivery
// row records the outcome, so the records queries refresh on settle.
export function useTestMessageSourceRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ routeId }: { routeId: string }) => api.testMessageSourceRoute(routeId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.deliveriesAll(wsId) });
    },
  });
}

export function useApproveMessageSourceTarget() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: ApproveMessageSourceTargetRequest) =>
      api.approveMessageSourceTarget(data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.approvedTargets(wsId) });
    },
  });
}

export function useRevokeMessageSourceTarget() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ targetId }: { targetId: string }) => api.revokeMessageSourceTarget(targetId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.approvedTargets(wsId) });
      // Revocation cancels queued sends against the frozen target.
      qc.invalidateQueries({ queryKey: messageSourceKeys.deliveriesAll(wsId) });
    },
  });
}

export function useRetryMessageRouteDelivery() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ routeId, deliveryId }: { routeId: string; deliveryId: string }) =>
      api.retryMessageRouteDelivery(routeId, deliveryId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageSourceKeys.deliveriesAll(wsId) });
      qc.invalidateQueries({
        queryKey: messageSourceKeys.delivery(wsId, vars.routeId, vars.deliveryId),
      });
    },
  });
}
