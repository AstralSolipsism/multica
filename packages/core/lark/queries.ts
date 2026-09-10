import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

/** Query key namespace for everything Lark-installation-related. Realtime
 * sync invalidates `installations(wsId)` on `lark_installation:*` events
 * so the Settings panel updates without a refetch. */
export const larkKeys = {
  all: (wsId: string) => ["lark", wsId] as const,
  installations: (wsId: string) => [...larkKeys.all(wsId), "installations"] as const,
};

export const larkInstallationsOptions = (wsId: string) =>
  queryOptions({
    queryKey: larkKeys.installations(wsId),
    queryFn: () => api.listLarkInstallations(wsId),
    enabled: !!wsId,
  });

export function useSetLarkConversation(wsId: string, installationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chats: { chat_id: string; chat_type: "group" | "p2p" }[]) => api.setLarkConversation(wsId, installationId, chats),
    onSuccess: () => qc.invalidateQueries({ queryKey: larkKeys.installations(wsId) }),
  });
}
