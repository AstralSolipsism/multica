"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import type { WikiComment, WikiCommentAnchor, WikiThread } from "@multica/core/api";
import { useWikiCommentAction, type WikiCommentAction } from "@multica/core/projects/queries";
import { Button } from "@multica/ui/components/ui/button";
import { ArrowLeft, Check, LoaderCircle } from "@multica/ui/icons";
import { ContentEditor, ReadonlyContent, type ContentEditorRef } from "../../editor";
import { useT } from "../../i18n";
import { blockedShortReasonLabel } from "../../issues/blocked-trigger-copy";
import { useFormatRelativeDate } from "./labels";

export type WikiDiscussion = { mode: "outline" } | { mode: "list" } | { mode: "thread"; id: string; siblings?: string[] } | { mode: "compose"; anchor: WikiCommentAnchor };

function WikiCommentComposer({ initial = "", busy, onSend, editing = false }: { initial?: string; busy: boolean; onSend: (body: string) => Promise<void>; editing?: boolean }) {
  const { t } = useT("engineering");
  const editor = useRef<ContentEditorRef>(null);
  const [body, setBody] = useState(initial);
  const submitting = useRef(false);
  const send = async () => {
    const content = editor.current?.getMarkdown() ?? body;
    if (busy || submitting.current || !content.trim() || [...content].length > 4000) return;
    submitting.current = true; editor.current?.setInputLocked(true);
    try { await onSend(content); editor.current?.clearContent(); setBody(""); }
    catch { /* The panel owns the visible error; keep the editor for retry. */ }
    finally { submitting.current = false; editor.current?.setInputLocked(false); }
  };
  return <div className="mt-3 space-y-2" aria-busy={busy}>
    <div className="max-h-64 overflow-y-auto rounded-md border p-2" aria-disabled={busy}>
      <ContentEditor ref={editor} defaultValue={initial} debounceMs={0} onUpdate={setBody} onSubmit={() => void send()} placeholder={t(($) => $.wikiComments.placeholder)} className="min-h-20 text-body" />
    </div>
    <p className="text-micro text-muted-foreground">{editing ? t(($) => $.wikiComments.editHint) : /mention:\/\/(agent|squad)\//.test(body) ? t(($) => $.wikiComments.wakeHint) : t(($) => $.wikiComments.quietHint)}</p>
    <Button type="button" size="sm" disabled={busy || !body.trim() || [...body].length > 4000} onClick={() => void send()}>{busy ? <LoaderCircle className="size-3 animate-spin" /> : null}{t(($) => $.wikiComments.send)}</Button>
  </div>;
}

function WikiCommentItem({ comment, own, canDelete, busy, onAction }: { comment: WikiComment; own: boolean; canDelete: boolean; busy: boolean; onAction: (action: WikiCommentAction) => Promise<unknown> }) {
  const { t } = useT("engineering");
  const { getActorName, getActorInitials } = useActorName();
  const relative = useFormatRelativeDate();
  const [editing, setEditing] = useState(false), [confirming, setConfirming] = useState(false);
  return <div className="border-b py-3 last:border-0" data-wiki-comment={comment.id}>
    <div className="flex items-center gap-2 text-caption">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-micro">{getActorInitials(comment.authorType, comment.authorId)}</span>
      <span className="min-w-0 truncate font-medium">{getActorName(comment.authorType, comment.authorId)}</span>
      {comment.authorType === "agent" ? <span className="text-micro text-muted-foreground">{t(($) => $.wikiComments.agent)}</span> : null}
      <time className="ml-auto whitespace-nowrap text-micro text-muted-foreground" dateTime={comment.createdAt}>{relative(comment.createdAt)}</time>
    </div>
    {editing ? <WikiCommentComposer initial={comment.bodyMarkdown} busy={busy} editing onSend={async (body) => { await onAction({ kind: "edit", id: comment.id, body }); setEditing(false); }} /> : <ReadonlyContent content={comment.bodyMarkdown} className="mt-2 break-words text-body" />}
    {comment.editedAt ? <span className="text-micro text-muted-foreground">{t(($) => $.wikiComments.edited)}</span> : null}
    <div className="mt-1 flex flex-wrap gap-1">
      {own ? <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? t(($) => $.wikiComments.cancel) : t(($) => $.wikiComments.edit)}</Button> : null}
      {canDelete && !confirming ? <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{t(($) => $.wikiComments.delete)}</Button> : null}
      {confirming ? <><Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => { void onAction({ kind: "delete", id: comment.id }).catch(() => {}); }}>{t(($) => $.wikiComments.confirmDelete)}</Button><Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>{t(($) => $.wikiComments.cancel)}</Button></> : null}
    </div>
  </div>;
}

export function WikiCommentsPanel({ workspaceId, projectId, pageId, pageSlug, threads, discussion, onDiscussion, loading, loadError }: {
  workspaceId: string; projectId: string; pageId: string; pageSlug: string; threads: WikiThread[];
  discussion: WikiDiscussion; onDiscussion: (next: WikiDiscussion) => void; loading: boolean; loadError: boolean;
}) {
  const { t } = useT("engineering");
  const { getActorName } = useActorName();
  const { t: issuesT } = useT("issues");
  const statusLabel = (status: string, reason: string) => {
    switch (status) {
      case "queued": return t(($) => $.wikiComments.queued);
      case "coalesced": return t(($) => $.wikiComments.coalesced);
      case "deferred": return t(($) => $.wikiComments.deferred);
      case "steered": return t(($) => $.wikiComments.steered);
      default: return blockedShortReasonLabel(reason, issuesT);
    }
  };
  const userId = useAuthStore((s) => s.user?.id);
  const members = useQuery(memberListOptions(workspaceId));
  const admin = members.data?.some((m) => m.user_id === userId && (m.role === "owner" || m.role === "admin"));
  const action = useWikiCommentAction(workspaceId, projectId, pageId, pageSlug);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [error, setError] = useState(false);
  const [dispatch, setDispatch] = useState<{ threadId: string; targets: { targetType: string; targetId: string; status: string; reasonCode: string }[] } | null>(null);
  const active = discussion.mode === "thread" ? threads.find((thread) => thread.id === discussion.id) : null;
  const run = async (input: WikiCommentAction) => {
    setError(false);
    try {
      const result = await action.mutateAsync(input);
      if ("woke" in result) setDispatch({ threadId: result.thread.id, targets: result.woke });
      if ("thread" in result) onDiscussion({ mode: "thread", id: result.thread.id });
      if (input.kind === "delete" && active?.comments.length === 1) onDiscussion({ mode: "list" });
      return result;
    } catch (cause) { setError(true); throw cause; }
  };
  const anchor = discussion.mode === "compose" ? discussion.anchor : active?.anchor;
  const changed = active?.location.state === "section_only" || active?.location.state === "orphaned";
  const list = threads.filter((thread) => (filter === "resolved") === !!thread.resolvedAt)
    .sort((a, b) => Number(a.location.state === "orphaned") - Number(b.location.state === "orphaned"));
  const woke = dispatch?.threadId === active?.id ? dispatch?.targets ?? [] : [];
  const siblings = discussion.mode === "thread" ? (discussion.siblings ?? []).filter((id) => threads.some((thread) => thread.id === id)) : [];
  return <div className="flex h-full min-h-0 flex-col" data-wiki-comments>
    <div className="shrink-0 p-3"><Button type="button" size="sm" variant="ghost" onClick={() => onDiscussion({ mode: "outline" })}><ArrowLeft className="size-3.5" />{t(($) => $.wikiComments.outline)}</Button>
      {discussion.mode !== "list" ? <Button type="button" size="xs" variant="ghost" onClick={() => onDiscussion({ mode: "list" })}>{t(($) => $.wikiComments.all)}</Button> : null}</div>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
      {loadError || error ? <p role="alert" className="mb-2 text-caption text-destructive">{t(($) => $.wikiComments.failed)}</p> : null}
      {discussion.mode === "list" ? <>
        <div className="mb-3 flex gap-1">{(["open", "resolved"] as const).map((state) => <Button key={state} type="button" size="sm" variant={state === filter ? "brandSubtle" : "ghost"} onClick={() => setFilter(state)}>{state === "open" ? t(($) => $.wikiComments.open) : t(($) => $.wikiComments.resolved)} ({threads.filter((thread) => !!thread.resolvedAt === (state === "resolved")).length})</Button>)}</div>
        {!loading && !list.length ? <p className="text-caption text-muted-foreground">{t(($) => $.wikiComments.empty)}</p> : null}
        {list.map((thread, index) => <div key={thread.id}>
          {thread.location.state === "orphaned" && list[index - 1]?.location.state !== "orphaned" ? <p className="mb-2 mt-4 text-caption font-medium">{t(($) => $.wikiComments.changed)}</p> : null}
          <button type="button" className="mb-2 block w-full rounded-md border p-3 text-left hover:bg-muted/40" onClick={() => onDiscussion({ mode: "thread", id: thread.id })}>
          <span className="block truncate text-caption font-medium">{thread.anchor.sectionTitle || pageSlug}</span>
          <span className="mt-1 line-clamp-2 text-caption text-muted-foreground">{thread.anchor.exact || thread.comments[0]?.bodyMarkdown}</span>
          {thread.location.state === "section_only" || thread.location.state === "orphaned" ? <span className="mt-1 block text-micro text-muted-foreground">{t(($) => $.wikiComments.changed)}</span> : null}
          <span className="mt-1 block text-micro">{t(($) => $.wikiComments.count, { count: thread.comments.length })}</span>
        </button></div>)}
      </> : <>
        {siblings.length > 1 && discussion.mode === "thread" ? <div className="mb-2 flex flex-wrap gap-1">{siblings.map((id, i) => <Button key={id} type="button" size="xs" variant={id === discussion.id ? "brandSubtle" : "ghost"} onClick={() => onDiscussion({ mode: "thread", id, siblings })}>{t(($) => $.wikiComments.sameLine, { index: i + 1, count: siblings.length })}</Button>)}</div> : null}
        {anchor ? <div className="rounded-md bg-muted/60 p-3 text-caption">
          <div className="font-medium">§ {anchor.sectionTitle || pageSlug}</div>
          {changed ? <p className="mt-1 text-muted-foreground">{t(($) => $.wikiComments.changed)} · {t(($) => $.wiki.versionPill, { number: anchor.revisionNumber })}</p> : null}
          {anchor.exact ? <blockquote className="mt-2 line-clamp-3 whitespace-pre-wrap break-words border-l-2 pl-2">{anchor.exact}</blockquote> : null}
        </div> : null}
        {discussion.mode === "compose" ? <WikiCommentComposer busy={action.isPending} onSend={async (body) => { await run({ kind: "create", anchor: discussion.anchor, body }); }} /> : active ? <>
          {active.comments.map((comment) => <WikiCommentItem key={comment.id} comment={comment} own={comment.authorType === "member" && comment.authorId === userId} canDelete={!!admin || (comment.authorType === "member" && comment.authorId === userId)} busy={action.isPending} onAction={run} />)}
          {active.resolvedAt ? <p className="my-3 text-caption text-muted-foreground">{t(($) => $.wikiComments.resolvedBy, { name: getActorName(active.resolvedByType ?? "member", active.resolvedById ?? "") })}</p> : <WikiCommentComposer key={active.id} busy={action.isPending} onSend={async (body) => { await run({ kind: "reply", id: active.id, body }); }} />}
          <Button type="button" size="sm" variant="ghost" className="mt-3" disabled={action.isPending} onClick={() => { void run({ kind: "resolve", id: active.id, resolved: !active.resolvedAt }).catch(() => {}); }}><Check className="size-3.5" />{active.resolvedAt ? t(($) => $.wikiComments.reopen) : t(($) => $.wikiComments.resolve)}</Button>
        </> : !loading ? <p className="mt-3 text-caption text-muted-foreground">{t(($) => $.wikiComments.missing)}</p> : null}
      </>}
      {woke.map((target) => <p key={`${target.targetType}-${target.targetId}`} className="mt-2 text-caption" role="status">{t(($) => $.wikiComments.woke, { name: getActorName(target.targetType, target.targetId), status: statusLabel(target.status, target.reasonCode) })}</p>)}
    </div>
  </div>;
}
