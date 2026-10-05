"use client";

// Labrastro fork (OL-104/OL-106): import diagnostics notices and local
// archive error localization for the create-skill dialog. Upstream
// `create-skill-dialog.tsx` keeps one-line mounts in its URL and local
// forms; the notice state and view live here.

import { useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import type { Skill, SkillImportDiagnostic } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { isMultipleSkillsError } from "../lib/utils";
import { SkillDiagnosticsNotice } from "./skill-diagnostics-notice";

/** Success-with-notices step shared by the URL and local import forms
 *  (OL-104): the skill was created, and the source left diagnostics the
 *  user should see before navigating away. */
function ImportNoticesView({
  skill,
  diagnostics,
  onContinue,
}: {
  skill: Skill;
  diagnostics: readonly SkillImportDiagnostic[];
  onContinue: (skill: Skill) => void;
}) {
  const { t } = useT("skill-packages");
  return (
    <>
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        <SkillDiagnosticsNotice
          title={t(($) => $.diagnostics.imported_with_notices, { count: diagnostics.length })}
          diagnostics={diagnostics}
        />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
        <Button type="button" size="sm" onClick={() => onContinue(skill)}>
          {t(($) => $.diagnostics.view_skill)}
        </Button>
      </div>
    </>
  );
}

/**
 * Import notices for the URL and local forms. `hold` runs after the created
 * skill is seeded into the caches: when the source left diagnostics it
 * swaps the form for the notice view (no success toast, navigation deferred
 * to "View skill") and returns true so the caller stops there.
 */
export function useImportNotices(onCreated: (skill: Skill) => void): {
  hold: (skill: Skill) => boolean;
  view: ReactNode;
  /** Unreadable import result: indeterminate — the skill may or may not
   *  exist. Shown as the form error; never navigate as if it succeeded. */
  unreadableMessage: string;
} {
  const { t: tPkg } = useT("skill-packages");
  const [notices, setNotices] = useState<{ skill: Skill; diagnostics: SkillImportDiagnostic[] } | null>(null);

  const hold = (skill: Skill): boolean => {
    const diagnostics = skill.diagnostics ?? [];
    if (diagnostics.length === 0) return false;
    setNotices({ skill, diagnostics });
    return true;
  };

  const view = notices ? (
    <ImportNoticesView
      skill={notices.skill}
      diagnostics={notices.diagnostics}
      onContinue={onCreated}
    />
  ) : null;

  return {
    hold,
    view,
    unreadableMessage: tPkg(($) => $.preview.malformed_apply_description),
  };
}

/**
 * Local `.skill`/`.zip` import errors the fork words differently; null keeps
 * the upstream message. A multi-skill archive rejected by the server gets
 * the same localized recovery as the folder path (OL-106), not the English
 * sentence the handler sends, and an Error without a message falls back to
 * the generic failure text.
 */
export function localArchiveImportError(
  err: unknown,
  t: TFunction<"skills">,
  tForkUi: TFunction<"fork-ui">,
): string | null {
  const message = err instanceof Error ? err.message : "";
  if (isMultipleSkillsError(message)) return tForkUi(($) => $.skills.create.local.multiple_skills);
  if (err instanceof Error && !message) return t(($) => $.create.local.fallback_error);
  return null;
}
