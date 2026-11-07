import { MessageSquarePlus } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import type { BaselineRevision } from "@multica/core/api";
import { BASELINE_ANNOTATION_QUOTE_LIMIT } from "@multica/core/projects/baseline-annotation-draft-store";
import { indexCommentText } from "../../issues/components/comment-annotation-selection";
import { useT } from "../../i18n";
import type { BaselineDisplaySection } from "./engineering-baseline-utils";
import type {
  BaselineAnnotationThread,
  BaselineComposerAnchor,
} from "./engineering-baseline-annotation-model";
import type { BaselineAnnotationDraftItem } from "@multica/core/projects/baseline-annotation-draft-store";
import { isBaselineAnnotationReply, anchorOutdated, anchorPlacement } from "./engineering-baseline-annotation-model";
import {
  BaselineAnnotationComposer,
  BaselineSubmittedThread,
  PendingBaselineAnnotationCard,
} from "./engineering-baseline-annotation-card";

export function BaselineAnnotateSectionButton({ onClick }: { onClick: () => void }) {
  const { t } = useT("engineering");
  return <Button type="button" size="xs" variant="ghost" className="opacity-100 lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover/section:opacity-100 [@media(hover:none)]:opacity-100" onClick={onClick}><MessageSquarePlus aria-hidden="true" />{t(($) => $.annotations.annotateSection)}</Button>;
}

export function createBaselineTextAnchor(
  article: HTMLElement,
  section: BaselineDisplaySection,
  adopted: BaselineRevision,
  targetLabel: string,
): BaselineComposerAnchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const root = article.querySelector<HTMLElement>("[data-baseline-markdown]");
  if (!root) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const { text, nodes } = indexCommentText(root);
  const selected = nodes.filter(({ node }) => range.intersectsNode(node));
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  const start = first.start + (range.startContainer === first.node ? range.startOffset : 0);
  const rawEnd = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length);
  const end = Math.min(rawEnd, start + BASELINE_ANNOTATION_QUOTE_LIMIT);
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  return {
    anchorKind: "text",
    targetRevisionId: adopted.id,
    sectionAnchor: section.anchor,
    sectionTitle: section.title,
    quote,
    start,
    prefix: text.slice(Math.max(0, start - 64), start),
    suffix: text.slice(end, end + 64),
    targetLabel,
  };
}

interface ReadingAnnotationsProps {
  section: BaselineDisplaySection;
  adopted: BaselineRevision;
  threads: readonly BaselineAnnotationThread[];
  pendingItems: readonly BaselineAnnotationDraftItem[];
  composer: BaselineComposerAnchor | null;
  canDecide: boolean;
  limitReached: boolean;
  onAddAnnotation: (anchor: BaselineComposerAnchor, note: string) => boolean;
  onCancelComposer: () => void;
  onAddReply: (thread: BaselineAnnotationThread, note: string) => boolean;
  onUpdatePending: (id: string, note: string) => void;
  onDeletePending: (id: string) => void;
  onResolve: (annotationId: string, resolved: boolean) => Promise<boolean>;
}

export function BaselineReadingAnnotations(props: ReadingAnnotationsProps) {
  const { t } = useT("engineering");
  const pending = props.pendingItems.filter((item) => !isBaselineAnnotationReply(item));
  if (!props.threads.length && !pending.length && !props.composer) return null;
  // Reading mode renders the adopted baseline only: line anchors exist for the
  // adopted revision itself, anything else has no rendered lines to land on.
  const placement = (root: BaselineAnnotationThread["root"]) => anchorPlacement(root, props.adopted.id, props.adopted);
  const outdated = (root: BaselineAnnotationThread["root"]) => anchorOutdated(root, props.adopted.id, props.adopted);
  return (
    <div className="mt-3 space-y-2 border-l-2 border-brand/30 pl-3" data-reading-annotations={props.section.anchor}>
      {props.threads.map((thread) => (
        <BaselineSubmittedThread
          key={thread.root.id}
          thread={thread}
          canDecide={props.canDecide}
          limitReached={props.limitReached}
          placement={placement(thread.root)}
          outdated={outdated(thread.root)}
          onAddReply={(note) => props.onAddReply(thread, note)}
          onUpdatePending={props.onUpdatePending}
          onDeletePending={props.onDeletePending}
          onResolve={(resolved) => props.onResolve(thread.root.id, resolved)}
        />
      ))}
      {pending.map((item) => <PendingBaselineAnnotationCard key={item.id} item={item} targetLabel={t(($) => $.baseline.baseMode, { number: props.adopted.revisionNumber })} onUpdate={props.onUpdatePending} onDelete={props.onDeletePending} />)}
      {props.composer ? <BaselineAnnotationComposer anchor={props.composer} limitReached={props.limitReached} onAdd={(note) => props.onAddAnnotation(props.composer!, note)} onCancel={props.onCancelComposer} /> : null}
    </div>
  );
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
