import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, type BaselineChapter, type BaselineRevision } from "../api";
import { projectKeys } from "./queries";

export interface EngineeringCandidateLocation {
  chapter: BaselineChapter;
  revision: BaselineRevision;
  current: boolean;
}

export function engineeringCandidateOptions(wsId: string, projectId: string, candidateId: string) {
  return queryOptions({
    queryKey: [...projectKeys.engineeringAll(wsId, projectId), "candidate", candidateId] as const,
    enabled: !!wsId && !!projectId && !!candidateId,
    queryFn: async (): Promise<EngineeringCandidateLocation | null> => {
      const overview = await api.getProjectEngineering(wsId, projectId);
      if (!overview) throw new ApiError("Invalid engineering response", 502, "Invalid engineering response");
      for (const chapter of overview.chapters) {
        if (chapter.candidate?.id === candidateId) {
          return { chapter: chapter.chapter, revision: chapter.candidate, current: true };
        }
      }
      // Module chapters hold history too. Scan metadata only, then read the
      // one matching revision with its body.
      const chapters: BaselineChapter[] = overview.chapters.map((item) => item.chapter);
      for (const chapter of chapters) {
        let before: number | undefined;
        do {
          const history = await api.getProjectBaselineHistory(wsId, projectId, chapter, { limit: 200, before, withContent: false });
          if (!history) throw new ApiError("Invalid baseline history response", 502, "Invalid baseline history response");
          const summary = history.revisions.find((item) => item.id === candidateId);
          if (summary) {
            const page = await api.getProjectBaselineHistory(wsId, projectId, chapter, { limit: 1, before: summary.revisionNumber + 1 });
            if (!page) throw new ApiError("Invalid baseline history response", 502, "Invalid baseline history response");
            const revision = page.revisions.find((item) => item.id === candidateId);
            return revision ? { chapter, revision, current: false } : null;
          }
          before = history.nextBefore ?? undefined;
          if (!history.hasMore) break;
        } while (before !== undefined);
      }
      return null;
    },
  });
}
