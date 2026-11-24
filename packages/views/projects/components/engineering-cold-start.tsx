"use client";

import { useState } from "react";
import { Check, LoaderCircle } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { useEngineeringWikiPages } from "./use-engineering-wiki-pages";

export function EngineeringColdStart({ projectId, saving, onSaveStrategy, onOpenSettings, onSkip }: {
  projectId: string;
  saving: boolean;
  onSaveStrategy: (data: { modeSummary: string; stages: [{ stage: 1; title: string; goal: string }] }) => Promise<boolean>;
  onOpenSettings: () => void;
  onSkip: () => void;
}) {
  const { t } = useT("engineering");
  const { createGuide, createBlank, pending: wikiPending } = useEngineeringWikiPages(projectId);
  const [editingStrategy, setEditingStrategy] = useState(true);
  const [strategy, setStrategy] = useState("");
  const [stageName, setStageName] = useState("");
  const [stageGoal, setStageGoal] = useState("");
  const [strategyDone, setStrategyDone] = useState(false);
  const [wikiDone, setWikiDone] = useState(false);
  const [readyDone, setReadyDone] = useState(false);
  const complete = [strategyDone, wikiDone, readyDone].filter(Boolean).length;

  const stepNumber = (done: boolean, number: number) => (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border text-caption", done && "border-success bg-success text-success-foreground")}>
      {done ? <Check className="size-3.5" aria-hidden="true" /> : number}
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6" data-engineering-cold-start>
      <section className="w-full max-w-[620px] rounded-md border bg-surface" aria-label={t(($) => $.cold.title)}>
        <header className="flex items-center justify-between border-b px-5 py-4">
          <h1 className="text-title-sm font-semibold">{t(($) => $.cold.title)}</h1>
          <span className="text-caption text-muted-foreground tabular-nums">{t(($) => $.cold.progress, { count: complete })}</span>
        </header>
        <section className="border-b p-5">
          <div className="flex items-center gap-3">
            {stepNumber(strategyDone, 1)}
            <div className="min-w-0 flex-1"><h2 className="text-label font-medium">{t(($) => $.cold.strategyStep)}</h2><p className="mt-1 text-caption text-muted-foreground">{t(($) => $.cold.strategyHint)}</p></div>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingStrategy((value) => !value)}>{t(($) => strategyDone ? $.actions.expand : editingStrategy ? $.actions.collapse : $.actions.expand)}</Button>
          </div>
          {editingStrategy ? (
            <div className="ml-9 mt-3 grid gap-2 border-l pl-4">
              <Textarea aria-label={t(($) => $.cold.strategyPlaceholder)} value={strategy} onChange={(event) => setStrategy(event.target.value)} rows={2} maxLength={280} disabled={saving} />
              <div className="grid gap-2 sm:grid-cols-2">
                <Input aria-label={t(($) => $.cold.stageNamePlaceholder)} value={stageName} onChange={(event) => setStageName(event.target.value)} maxLength={80} disabled={saving} />
                <Input aria-label={t(($) => $.cold.stageGoalPlaceholder)} value={stageGoal} onChange={(event) => setStageGoal(event.target.value)} maxLength={280} disabled={saving} />
              </div>
              <div className="flex justify-end"><Button size="sm" disabled={saving || !strategy.trim() || !stageName.trim()} onClick={async () => {
                if (await onSaveStrategy({ modeSummary: strategy.trim(), stages: [{ stage: 1, title: stageName.trim(), goal: stageGoal.trim() }] })) {
                  setStrategyDone(true);
                  setEditingStrategy(false);
                }
              }}>{saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.actions.save)}</Button></div>
            </div>
          ) : null}
        </section>
        <section className="border-b p-5">
          <div className="flex items-center gap-3">
            {stepNumber(wikiDone, 2)}
            <div className="min-w-0 flex-1"><h2 className="text-label font-medium">{t(($) => $.cold.wikiStep)}</h2><p className="mt-1 text-caption text-muted-foreground">{t(($) => $.cold.wikiHint)}</p></div>
            {!wikiDone ? <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={wikiPending !== null} onClick={async () => { if (await createBlank()) setWikiDone(true); }}>{t(($) => $.cold.createBlank)}</Button>
              <Button type="button" size="sm" disabled={wikiPending !== null} onClick={async () => { if (await createGuide()) setWikiDone(true); }}>{wikiPending === "guide" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}{t(($) => $.cold.createGuide)}</Button>
            </div> : null}
          </div>
        </section>
        <section className="p-5">
          <div className="flex items-center gap-3">
            {stepNumber(readyDone, 3)}
            <div className="min-w-0 flex-1"><h2 className="text-label font-medium">{t(($) => $.cold.readyStep)}</h2><p className="mt-1 text-caption text-muted-foreground">{t(($) => $.cold.readyHint)}</p></div>
            <Button type="button" variant="outline" size="sm" onClick={() => { setReadyDone(true); onOpenSettings(); }}>{t(($) => $.cold.openSettings)}</Button>
          </div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-page-canvas px-5 py-3 text-caption text-muted-foreground">
          <span>{t(($) => $.cold.footerHint)}</span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="link" size="sm" onClick={onSkip}>{t(($) => $.cold.skip)}</Button>
            {complete === 3 ? <Button type="button" size="sm" onClick={onSkip}>{t(($) => $.cold.enter)}</Button> : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
