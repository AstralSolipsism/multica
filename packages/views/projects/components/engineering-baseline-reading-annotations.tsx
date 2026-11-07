import { MessageSquarePlus } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import type { BaselineRevision } from "@multica/core/api";
import { useT } from "../../i18n";
import type { BaselineDisplaySection } from "./engineering-baseline-utils";
import type {
  BaselineAnnotationThread,
  BaselineComposerAnchor,
} from "./engineering-baseline-annotation-model";
import type { BaselineAnnotationDraftItem } from "@multica/core/projects/baseline-annotation-draft-store";
import { anchorOutdated, anchorPlacement } from "./engineering-baseline-annotation-model";
import { captureBaselineTextRange } from "./engineering-baseline-text-annotations";
import { BaselineSubmittedThread } from "./engineering-baseline-annotation-card";
import { baselineReadingEntries } from "./engineering-baseline-reading-card";
import { BaselineInlineReadingEntry } from "./engineering-baseline-reading-inline";

export function BaselineAnnotateSectionButton({ onClick }: { onClick: () => void }) {
  const { t } = useT("engineering");
  return <Button type="button" size="xs" variant="ghost" className="opacity-100 lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover/section:opacity-100 [@media(hover:none)]:opacity-100" onClick={onClick}><MessageSquarePlus aria-hidden="true" />{t(($) => $.annotations.annotateSection)}</Button>;
}

export function captureBaselineTextAnchor(
  article: HTMLElement,
  section: BaselineDisplaySection,
  adopted: BaselineRevision,
  targetLabel: string,
): { anchor: BaselineComposerAnchor; range: Range; root: HTMLElement } | null {
  const captured = captureBaselineTextRange(article, window.getSelection());
  if (!captured) return null;
  const { range, root, ...fields } = captured;
  return {
    anchor: {
      anchorKind: "text",
      targetRevisionId: adopted.id,
      sectionAnchor: section.anchor,
      sectionTitle: section.title,
      ...fields,
      targetLabel,
    },
    range,
    root,
  };
}

export function createBaselineTextAnchor(
  article: HTMLElement,
  section: BaselineDisplaySection,
  adopted: BaselineRevision,
  targetLabel: string,
): BaselineComposerAnchor | null {
  return captureBaselineTextAnchor(article, section, adopted, targetLabel)?.anchor ?? null;
}

interface ReadingAnnotationsProps {
  section: BaselineDisplaySection;
  adopted: BaselineRevision;
  /** The chapter's working candidate; placement falls back to the adopted revision. */
  candidate: BaselineRevision | null;
  threads: readonly BaselineAnnotationThread[];
  pendingItems: readonly BaselineAnnotationDraftItem[];
  composer: BaselineComposerAnchor | null;
  canDecide: boolean;
  limitReached: boolean;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onAddAnnotation: (anchor: BaselineComposerAnchor, note: string) => boolean;
  onCancelComposer: () => void;
  onAddReply: (thread: BaselineAnnotationThread, note: string) => boolean;
  onUpdatePending: (id: string, note: string) => void;
  onDeletePending: (id: string) => void;
  onResolve: (annotationId: string, resolved: boolean) => Promise<boolean>;
}

export function BaselineReadingAnnotations(props: ReadingAnnotationsProps) {
  const entries = baselineReadingEntries(props.threads, props.pendingItems, props.composer);
  if (!entries.length) return null;
  return entries.map((entry) => (
    <BaselineInlineReadingEntry
      key={entry.id}
      section={props.section}
      entry={entry}
      adopted={props.adopted}
      candidate={props.candidate}
      canDecide={props.canDecide}
      limitReached={props.limitReached}
      hoveredId={props.hoveredId}
      onHover={props.onHover}
      onAddAnnotation={props.onAddAnnotation}
      onCancelComposer={props.onCancelComposer}
      onAddReply={props.onAddReply}
      onUpdatePending={props.onUpdatePending}
      onDeletePending={props.onDeletePending}
      onResolve={props.onResolve}
    />
  ));
}

export function BaselineStandaloneThreads({ title, threads, baseRevisionId, candidate, forceOutdatedBadge, canDecide, limitReached, onAddReply, onUpdatePending, onDeletePending, onResolve }: {
  title: string;
  threads: readonly BaselineAnnotationThread[];
  baseRevisionId: string | null;
  candidate: BaselineRevision | null;
  /** Diff context: every thread here lacks a row to sit on. */
  forceOutdatedBadge?: boolean;
  canDecide: boolean;
  limitReached: boolean;
  onAddReply: (thread: BaselineAnnotationThread, note: string) => boolean;
  onUpdatePending: (id: string, note: string) => void;
  onDeletePending: (id: string) => void;
  onResolve: (annotationId: string, resolved: boolean) => Promise<boolean>;
}) {
  if (!threads.length) return null;
  return (
    <section className="mt-4 rounded-lg border p-3" data-unlocated-annotation-threads>
      <h3 className="mb-3 text-caption font-medium">{title}</h3>
      <div className="space-y-2">
        {threads.map((thread) => (
          <BaselineSubmittedThread
            key={thread.root.id}
            thread={thread}
            canDecide={canDecide}
            limitReached={limitReached}
            placement={anchorPlacement(thread.root, baseRevisionId, candidate)}
            outdated={forceOutdatedBadge && thread.root.anchorKind === "lines" || anchorOutdated(thread.root, baseRevisionId, candidate)}
            onAddReply={(note) => onAddReply(thread, note)}
            onUpdatePending={onUpdatePending}
            onDeletePending={onDeletePending}
            onResolve={(resolved) => onResolve(thread.root.id, resolved)}
          />
        ))}
      </div>
    </section>
  );
}
