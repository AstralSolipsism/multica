"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError, errorCode, WikiConflictSchema } from "@multica/core/api";
import { useCreateWikiPage } from "@multica/core/projects/mutations";
import { useT } from "../../i18n";
import type { WikiEditorConflictInfo } from "./engineering-baseline-editor";

const GUIDE_SLUGS = ["overview", "domain_rules", "architecture", "exclusions_and_risks"] as const;

export function wikiConflictFromError(cause: unknown): WikiEditorConflictInfo | null {
  if (!(cause instanceof ApiError) || errorCode(cause) !== "baseline_conflict") return null;
  const parsed = WikiConflictSchema.safeParse(cause.body);
  return parsed.success ? {
    revisionNumber: parsed.data.current.revisionNumber,
    kind: parsed.data.current.kind,
    createdAt: parsed.data.current.createdAt,
    createdByType: parsed.data.current.createdByType,
    createdById: parsed.data.current.createdById,
    changeSummary: parsed.data.current.changeSummary,
  } : null;
}

/** Shared cold-start/tree writes so both entry points create identical pages. */
export function useEngineeringWikiPages(projectId: string) {
  const { t } = useT("engineering");
  const createPage = useCreateWikiPage();
  const [pending, setPending] = useState<"guide" | "blank" | null>(null);

  const createGuide = useCallback(async () => {
    setPending("guide");
    try {
      for (const slug of GUIDE_SLUGS) {
        const title = t(($) => $.chapters[slug]);
        try {
          await createPage.mutateAsync({
            projectId,
            title,
            slug,
            parent: "root",
            contentMarkdown: t(($) => $.wiki.guideTemplate, { title }),
          });
        } catch (cause) {
          if (errorCode(cause) !== "baseline_slug_taken") throw cause;
        }
      }
      toast.success(t(($) => $.wiki.guideBootstrapDone));
      return true;
    } catch {
      toast.error(t(($) => $.wiki.guideError, { title: t(($) => $.wiki.guideBootstrap) }));
      return false;
    } finally {
      setPending(null);
    }
  }, [createPage, projectId, t]);

  const createBlank = useCallback(async (parent = "root", afterError?: () => void) => {
    setPending("blank");
    try {
      const result = await createPage.mutateAsync({
        projectId,
        title: t(($) => $.wiki.untitled),
        parent,
      });
      if (!result) throw new Error("Unconfirmed create response");
      return result;
    } catch (cause) {
      const conflict = wikiConflictFromError(cause);
      if (conflict) toast.error(t(($) => $.wiki.conflictTreeToast, { number: conflict.revisionNumber }));
      else toast.error(t(($) => $.wiki.treeWriteError));
      afterError?.();
      return null;
    } finally {
      setPending(null);
    }
  }, [createPage, projectId, t]);

  return { createPage, createGuide, createBlank, pending };
}
