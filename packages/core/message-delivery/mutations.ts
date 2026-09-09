import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { messageDeliveryKeys } from "./queries";
import { useWorkspaceId } from "../hooks";
import type {
  ApproveMessageTargetRequest,
  SaveMessageRouteRequest,
} from "../types";

// No optimistic updates on this surface: a route only takes effect once the
// server commits it (revision-guarded, approval-checked, target-verified),
// and a "saved" route that the server rejected must never appear as saved.
// Every mutation settles by invalidating the authoritative queries.

export function useCreateMessageRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ autopilotId, ...data }: { autopilotId: string } & SaveMessageRouteRequest) =>
      api.createMessageRoute(autopilotId, data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.routes(wsId, vars.autopilotId) });
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.approvedTargets(wsId, vars.autopilotId) });
    },
  });
}

export function useUpdateMessageRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      autopilotId,
      routeId,
      ...data
    }: { autopilotId: string; routeId: string } & SaveMessageRouteRequest) =>
      api.updateMessageRoute(autopilotId, routeId, data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.routes(wsId, vars.autopilotId) });
    },
  });
}

export function useSetMessageRouteEnabled() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      autopilotId,
      routeId,
      enabled,
      expectedRevision,
    }: {
      autopilotId: string;
      routeId: string;
      enabled: boolean;
      expectedRevision: number;
    }) => api.setMessageRouteEnabled(autopilotId, routeId, enabled, expectedRevision),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.routes(wsId, vars.autopilotId) });
      // Disabling cancels queued sends; enabling restarts eligibility.
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.deliveriesAll(wsId, vars.autopilotId) });
    },
  });
}

export function useDeleteMessageRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ autopilotId, routeId }: { autopilotId: string; routeId: string }) =>
      api.deleteMessageRoute(autopilotId, routeId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.routes(wsId, vars.autopilotId) });
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.deliveriesAll(wsId, vars.autopilotId) });
    },
  });
}

// Test-send runs the real send path synchronously; the returned delivery
// row records the outcome, so the records list refreshes on settle.
export function useTestMessageRoute() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ autopilotId, routeId }: { autopilotId: string; routeId: string }) =>
      api.testMessageRoute(autopilotId, routeId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.deliveriesAll(wsId, vars.autopilotId) });
    },
  });
}

export function useApproveMessageTarget() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ autopilotId, ...data }: { autopilotId: string } & ApproveMessageTargetRequest) =>
      api.approveMessageTarget(autopilotId, data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.approvedTargets(wsId, vars.autopilotId) });
    },
  });
}

export function useRevokeMessageTarget() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ autopilotId, targetId }: { autopilotId: string; targetId: string }) =>
      api.revokeMessageTarget(autopilotId, targetId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.approvedTargets(wsId, vars.autopilotId) });
      // Revocation cancels queued sends against the frozen target.
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.deliveriesAll(wsId, vars.autopilotId) });
    },
  });
}

export function useRetryMessageDelivery() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ autopilotId, deliveryId }: { autopilotId: string; deliveryId: string }) =>
      api.retryMessageDelivery(autopilotId, deliveryId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: messageDeliveryKeys.deliveriesAll(wsId, vars.autopilotId) });
      qc.invalidateQueries({
        queryKey: messageDeliveryKeys.delivery(wsId, vars.autopilotId, vars.deliveryId),
      });
    },
  });
}
