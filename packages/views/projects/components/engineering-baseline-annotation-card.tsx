import { useState } from "react";
import { AlertTriangle, Bot, LoaderCircle } from "@multica/ui/icons";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useActorName } from "@multica/core/workspace/hooks";
import { BASELINE_ANNOTATION_NOTE_LIMIT } from "@multica/core/projects/baseline-annotation-draft-store";
import type {
  BaselineAnnotationDraft,
  BaselineAnnotationReplyDraft,
} from "@multica/core/projects/baseline-annotation-draft-store";
import { useT } from "../../i18n";
import { useFormatRelativeDate } from "./labels";
import type {
  BaselineAnnotationSide,
  BaselineAnnotationThread,
  BaselineComposerAnchor,
} from "./engineering-baseline-annotation-model";

function PendingBadge() {
  const { t } = useT("engineering");
  return <Badge variant="secondary">{t(($) => $.annotations.pendingBadge)}</Badge>;
}

function LineLocation({ start, end, side, targetLabel }: {
  start?: number;
  end?: number;
  side?: BaselineAnnotationSide;
  targetLabel?: string;
}) {
  const { t } = useT("engineering");
  if (start == null || end == null) return null;
  const range = start === end ? String(start) : `${start}–${end}`;
  return (
    <span className="text-micro text-muted-foreground">
      {t(($) => $.annotations.lineInSection, { range })}
      {side ? ` · ${t(($) => $.annotations.side[side])}` : ""}
      {targetLabel ? ` · ${targetLabel}` : ""}
    </span>
  );
}

export function BaselineAnnotationComposer({ anchor, noteLabel, limitReached, onAdd, onCancel }: {
  anchor: BaselineComposerAnchor;
  noteLabel?: string;
  limitReached: boolean;
  onAdd: (note: string) => boolean;
  onCancel: () => void;
}) {
  const { t } = useT("engineering");
  const [note, setNote] = useState("");
  const title = anchor.anchorKind === "lines"
    ? t(($) => $.annotations.annotateLines, { range: anchor.lineStart === anchor.lineEnd ? String(anchor.lineStart) : `${anchor.lineStart}–${anchor.lineEnd}` })
    : anchor.anchorKind === "section"
      ? t(($) => $.annotations.annotateSectionTitle, { title: anchor.sectionTitle })
      : t(($) => $.annotations.annotateSelection);
  return (
    <div className="rounded-lg border border-brand/50 bg-brand/5 p-3 shadow-sm" data-annotation-composer>
      <div className="flex flex-wrap items-center gap-x-2 text-caption font-medium">
        <span>{title}</span>
        {anchor.side ? <Badge variant="outline">{t(($) => $.annotations.side[anchor.side!])}</Badge> : null}
        <span className="text-muted-foreground">{anchor.targetLabel}</span>
      </div>
      {anchor.anchorKind === "lines" ? (
        <div className="mt-1 text-micro text-muted-foreground">
          {t(($) => $.annotations.lineInSection, { range: anchor.lineStart === anchor.lineEnd ? String(anchor.lineStart) : `${anchor.lineStart}–${anchor.lineEnd}` })}
        </div>
      ) : null}
      {anchor.quote ? <blockquote className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap border-l-2 pl-2 text-caption text-muted-foreground">{anchor.quote}</blockquote> : null}
      <label className="mt-3 block">
        <span className="sr-only">{noteLabel ?? t(($) => $.annotations.notePlaceholder)}</span>
        <Textarea
          autoFocus
          value={note}
          maxLength={BASELINE_ANNOTATION_NOTE_LIMIT}
          rows={3}
          placeholder={noteLabel ?? t(($) => $.annotations.notePlaceholder)}
          onChange={(event) => setNote(event.target.value)}
          className="bg-background"
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-micro text-muted-foreground">{Array.from(note).length}/{BASELINE_ANNOTATION_NOTE_LIMIT}</span>
        <div className="flex gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>{t(($) => $.actions.cancel)}</Button>
          <Button type="button" size="xs" disabled={!note.trim() || limitReached} onClick={() => { if (onAdd(note)) onCancel(); }}>{t(($) => $.annotations.addToReview)}</Button>
        </div>
      </div>
      {limitReached ? <p className="mt-2 text-caption text-destructive">{t(($) => $.annotations.limitReached)}</p> : null}
    </div>
  );
}

export function PendingBaselineAnnotationCard({ item, side, targetLabel, onUpdate, onDelete }: {
  item: BaselineAnnotationDraft | BaselineAnnotationReplyDraft;
  side?: BaselineAnnotationSide;
  targetLabel?: string;
  onUpdate: (id: string, note: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useT("engineering");
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(item.note);
  return (
    <article className="rounded-lg border border-dashed border-brand/60 bg-brand/5 p-3" data-pending-annotation={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium">{t(($) => $.annotations.you)}</span>
        <PendingBadge />
        {item.anchorKind === "section" ? <Badge variant="outline">{t(($) => $.annotations.wholeSection)}</Badge> : null}
        <LineLocation start={item.lineStart} end={item.lineEnd} side={side} targetLabel={targetLabel} />
      </div>
      {item.quote ? <blockquote className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap border-l-2 pl-2 text-caption text-muted-foreground">{item.quote}</blockquote> : null}
      {editing ? (
        <div className="mt-2">
          <label>
            <span className="sr-only">{t(($) => $.annotations.editNote)}</span>
            <Textarea value={note} maxLength={BASELINE_ANNOTATION_NOTE_LIMIT} rows={3} onChange={(event) => setNote(event.target.value)} className="bg-background" />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => { setEditing(false); setNote(item.note); }}>{t(($) => $.actions.cancel)}</Button>
            <Button type="button" size="xs" disabled={!note.trim()} onClick={() => { onUpdate(item.id, note); setEditing(false); }}>{t(($) => $.actions.save)}</Button>
          </div>
        </div>
      ) : <p className="mt-2 whitespace-pre-wrap break-words text-body">{item.note}</p>}
      <div className="mt-1 flex gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(true)}>{t(($) => $.annotations.edit)}</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => onDelete(item.id)}>{t(($) => $.annotations.delete)}</Button>
      </div>
    </article>
  );
}

function HumanReply({ note, createdById, createdAt }: { note: string; createdById: string; createdAt: string }) {
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  return (
    <div className="mt-3 border-t pt-3" data-annotation-human-reply>
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="font-medium">{getActorName("member", createdById)}</span>
        <time className="text-muted-foreground" dateTime={createdAt}>{formatRelativeDate(createdAt)}</time>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-body">{note}</p>
    </div>
  );
}

export function BaselineSubmittedThread({ thread, canDecide, limitReached, onAddReply, onUpdatePending, onDeletePending, onResolve }: {
  thread: BaselineAnnotationThread;
  canDecide: boolean;
  limitReached: boolean;
  onAddReply: (note: string) => boolean;
  onUpdatePending: (id: string, note: string) => void;
  onDeletePending: (id: string) => void;
  onResolve: (resolved: boolean) => Promise<boolean>;
}) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState(false);
  const { root, batch } = thread;
  const active = batch.state === "active";
  const resolved = root.state === "resolved";
  const changeResolved = async () => {
    if (resolving) return;
    setResolving(true);
    setError(false);
    const success = await onResolve(!resolved);
    if (!success) setError(true);
    setResolving(false);
  };
  return (
    <article className="rounded-lg border bg-card p-3" data-annotation-thread={root.id} data-annotation-state={root.state}>
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="font-medium">{getActorName("member", root.createdById)}</span>
        <time className="text-muted-foreground" dateTime={root.createdAt}>{formatRelativeDate(root.createdAt)}</time>
        {resolved ? <Badge variant="secondary">{t(($) => $.annotations.resolved)}</Badge> : null}
        {root.state === "archived" || !active ? <Badge variant="outline">{t(($) => $.annotations.readOnly)}</Badge> : null}
        {root.location === "outdated" ? <Badge variant="outline">{t(($) => $.annotations.outdated)}</Badge> : null}
        <LineLocation start={root.located?.lineStart ?? root.lineStart ?? undefined} end={root.located?.lineEnd ?? root.lineEnd ?? undefined} side={root.side === "unknown" ? undefined : root.side} />
      </div>
      {root.quote ? <blockquote className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap border-l-2 pl-2 text-caption text-muted-foreground">{root.quote}</blockquote> : null}
      <p className="mt-2 whitespace-pre-wrap break-words text-body">{root.note}</p>
      {thread.replies.map((item) => <HumanReply key={item.id} note={item.note} createdById={item.createdById} createdAt={item.createdAt} />)}
      {thread.pendingReplies.map((item) => (
        <div key={item.id} className="mt-3 border-t pt-3">
          <PendingBaselineAnnotationCard item={item} onUpdate={onUpdatePending} onDelete={onDeletePending} />
        </div>
      ))}
      {root.response ? (
        <div className="mt-3 rounded-md bg-brand/5 p-3" data-annotation-agent-response>
          <div className="flex items-center gap-2 text-caption font-medium"><Bot className="size-4 text-brand" aria-hidden="true" />{t(($) => $.annotations.agentResponse)}</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-body">{root.response}</p>
        </div>
      ) : null}
      {canDecide && active ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button type="button" size="xs" variant="ghost" disabled={limitReached} onClick={() => setReplyOpen((value) => !value)}>{t(($) => $.annotations.reply)}</Button>
          <Button type="button" size="xs" variant="ghost" disabled={resolving} aria-busy={resolving} onClick={() => void changeResolved()}>
            {resolving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {t(($) => resolved ? $.annotations.unresolve : $.annotations.resolve)}
          </Button>
        </div>
      ) : null}
      {replyOpen && canDecide && active ? (
        <div className="mt-3">
          <label>
            <span className="sr-only">{t(($) => $.annotations.replyPlaceholder)}</span>
            <Textarea value={reply} rows={2} maxLength={BASELINE_ANNOTATION_NOTE_LIMIT} placeholder={t(($) => $.annotations.replyPlaceholder)} onChange={(event) => setReply(event.target.value)} />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setReplyOpen(false)}>{t(($) => $.actions.cancel)}</Button>
            <Button type="button" size="xs" disabled={!reply.trim() || limitReached} onClick={() => { if (onAddReply(reply)) { setReply(""); setReplyOpen(false); } }}>{t(($) => $.annotations.addToReview)}</Button>
          </div>
          {limitReached ? <p className="mt-2 text-caption text-destructive">{t(($) => $.annotations.limitReached)}</p> : null}
        </div>
      ) : null}
      {error ? <Alert className="mt-3" variant="destructive"><AlertTriangle /><AlertDescription>{t(($) => $.annotations.resolveError)}</AlertDescription></Alert> : null}
    </article>
  );
}
