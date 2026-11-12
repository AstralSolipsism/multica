import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { WikiCommentAnchor } from "../api/labrastro-baseline-comment-schemas";
import { engineeringProjectKeys as keys } from "./engineering-query-keys";

export function wikiThreadsOptions(wsId: string, projectId: string, pageId: string) {
  return queryOptions({ queryKey: keys.wikiThreads(wsId, projectId, pageId), queryFn: () => api.getProjectWikiThreads(wsId, projectId, pageId), enabled: !!pageId });
}

export type WikiCommentAction =
  | { kind: "create"; anchor: WikiCommentAnchor; body: string }
  | { kind: "reply"; id: string; body: string }
  | { kind: "edit"; id: string; body: string }
  | { kind: "delete"; id: string }
  | { kind: "resolve"; id: string; resolved: boolean };

export function useWikiCommentAction(wsId: string, projectId: string, pageId: string, pageSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: WikiCommentAction) => {
      const result = await (() => {
        switch (action.kind) {
          case "create": return api.createProjectWikiThread(wsId, projectId, pageId, action.anchor, action.body);
          case "reply": return api.replyProjectWikiThread(wsId, projectId, action.id, action.body);
          case "edit": return api.editProjectWikiComment(wsId, projectId, action.id, action.body);
          case "delete": return api.deleteProjectWikiComment(wsId, projectId, action.id);
          case "resolve": return api.resolveProjectWikiThread(wsId, projectId, action.id, action.resolved);
        }
      })();
      if (!result) throw new Error("Invalid wiki comment response");
      return result;
    },
    onSuccess: async (_result, action) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.wikiThreads(wsId, projectId, pageId) }),
        qc.invalidateQueries({ queryKey: keys.wikiPageAll(wsId, projectId, pageSlug) }),
        ...(action.kind === "reply" || action.kind === "resolve" ? [qc.invalidateQueries({ queryKey: keys.wikiThread(wsId, projectId, action.id) })] : []),
      ]);
    },
  });
}
