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
    queryKey: [...projectKeys.all(wsId), "engineering-candidate", projectId, candidateId] as const,
    enabled: !!wsId && !!projectId && !!candidateId,
    queryFn: async (): Promise<EngineeringCandidateLocation | null> => {
      const overview = await api.getProjectEngineering(wsId, projectId);
      if (!overview) throw new ApiError("Invalid engineering response", 502, "Invalid engineering response");
      const chapters: BaselineChapter[] = ["overview", "domain_rules", "architecture", "exclusions_and_risks"];
      for (const chapter of overview.chapters) {
        if (chapter.candidate?.id === candidateId) {
          return { chapter: chapter.chapter, revision: chapter.candidate, current: true };
        }
      }
      for (const chapter of chapters) {
        let before: number | undefined;
        do {
          const history = await api.getProjectBaselineHistory(wsId, projectId, chapter, { limit: 200, before });
          if (!history) throw new ApiError("Invalid baseline history response", 502, "Invalid baseline history response");
          const revision = history.revisions.find((item) => item.id === candidateId);
          if (revision) return { chapter, revision, current: false };
          before = history.nextBefore ?? undefined;
          if (!history.hasMore) break;
        } while (before !== undefined);
      }
      return null;
    },
  });
}
