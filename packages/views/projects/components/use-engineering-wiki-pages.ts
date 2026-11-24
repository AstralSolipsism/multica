"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorCode } from "@multica/core/api";
import { useCreateWikiPage } from "@multica/core/projects/mutations";
import { useT } from "../../i18n";

const GUIDE_SLUGS = ["overview", "domain_rules", "architecture", "exclusions_and_risks"] as const;

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

  const createBlank = useCallback(async (parent = "root") => {
    setPending("blank");
    try {
      return await createPage.mutateAsync({
        projectId,
        title: t(($) => $.wiki.untitled),
        parent,
      });
    } catch (cause) {
      if (errorCode(cause) === "baseline_conflict") {
        toast.error(t(($) => $.wiki.conflictTreeToast, { number: 0 }));
      } else {
        toast.error(t(($) => $.wiki.treeWriteError));
      }
      return null;
    } finally {
      setPending(null);
    }
  }, [createPage, projectId, t]);

  return { createPage, createGuide, createBlank, pending };
}
