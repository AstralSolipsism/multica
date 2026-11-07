import type { BaselineAnnotation, BaselineRevision } from "@multica/core/api";
import type { BaselineAnnotationDraft, BaselineAnnotationDraftItem } from "@multica/core/projects/baseline-annotation-draft-store";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import {
  BaselineAnnotationComposer,
  BaselineSubmittedThread,
  PendingBaselineAnnotationCard,
} from "./engineering-baseline-annotation-card";
import {
  anchorOutdated,
  anchorPlacement,
  isBaselineAnnotationReply,
  type BaselineAnnotationThread,
  type BaselineComposerAnchor,
} from "./engineering-baseline-annotation-model";

export type BaselineReadingEntry = {
  id: string;
  anchor: BaselineAnnotation | BaselineAnnotationDraft | BaselineComposerAnchor;
} & (
  | { kind: "thread"; thread: BaselineAnnotationThread }
  | { kind: "pending"; item: BaselineAnnotationDraft }
  | { kind: "composer"; composer: BaselineComposerAnchor }
);

export function baselineReadingEntries(
  threads: readonly BaselineAnnotationThread[],
  pendingItems: readonly BaselineAnnotationDraftItem[],
  composer: BaselineComposerAnchor | null,
): BaselineReadingEntry[] {
  const entries: BaselineReadingEntry[] = [
    ...threads.map((thread): BaselineReadingEntry => ({ id: thread.root.id, kind: "thread", thread, anchor: thread.root })),
    ...pendingItems.filter((item): item is BaselineAnnotationDraft => !isBaselineAnnotationReply(item))
      .map((item): BaselineReadingEntry => ({ id: item.id, kind: "pending", item, anchor: item })),
  ];
  if (composer) entries.push({ id: "reading-composer", kind: "composer", composer, anchor: composer });
  return entries;
}

interface BaselineReadingEntryCardProps {
  entry: BaselineReadingEntry;
  adopted: BaselineRevision;
  candidate: BaselineRevision | null;
  canDecide: boolean;
  limitReached: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onAddAnnotation: (anchor: BaselineComposerAnchor, note: string) => boolean;
  onCancelComposer: () => void;
  onAddReply: (thread: BaselineAnnotationThread, note: string) => boolean;
  onUpdatePending: (id: string, note: string) => void;
  onDeletePending: (id: string) => void;
  onResolve: (annotationId: string, resolved: boolean) => Promise<boolean>;
}

export function BaselineReadingEntryCard(props: BaselineReadingEntryCardProps) {
  const { t } = useT("engineering");
  const { entry } = props;
  return (
    <div
      data-reading-annotation={entry.id}
      data-annotation-hovered={props.hovered ? "" : undefined}
      className={cn("rounded-lg transition-shadow", props.hovered && "ring-2 ring-brand/30")}
      onMouseEnter={() => props.onHover(entry.id)}
      onMouseLeave={() => props.onHover(null)}
      onFocus={() => props.onHover(entry.id)}
      onBlur={() => props.onHover(null)}
    >
      {entry.kind === "thread" ? (
        <BaselineSubmittedThread
          thread={entry.thread}
          canDecide={props.canDecide}
          limitReached={props.limitReached}
          placement={anchorPlacement(entry.thread.root, props.adopted.id, props.candidate)}
          outdated={anchorOutdated(entry.thread.root, props.adopted.id, props.candidate)}
          onAddReply={(note) => props.onAddReply(entry.thread, note)}
          onUpdatePending={props.onUpdatePending}
          onDeletePending={props.onDeletePending}
          onResolve={(resolved) => props.onResolve(entry.thread.root.id, resolved)}
        />
      ) : entry.kind === "pending" ? (
        <PendingBaselineAnnotationCard
          item={entry.item}
          targetLabel={t(($) => $.baseline.baseMode, { number: props.adopted.revisionNumber })}
          onUpdate={props.onUpdatePending}
          onDelete={props.onDeletePending}
        />
      ) : (
        <BaselineAnnotationComposer
          anchor={entry.composer}
          limitReached={props.limitReached}
          onAdd={(note) => props.onAddAnnotation(entry.composer, note)}
          onCancel={props.onCancelComposer}
        />
      )}
    </div>
  );
}
