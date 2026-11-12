"use client";

// Wiki page/section editor (OL-1329 §6). One editor at a time; markdown source
// + toolbar + 编辑/预览 tabs + optional change summary and related issue. All
// saves carry an explicit base revision number; a 409 optimistic-lock rejection
// renders the three-path conflict panel and never discards the draft.

import { useEffect, useRef, useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { Bold, Code, Heading2, Heading3, Link, List, ListOrdered, Table2 } from "@multica/ui/icons";
import { useT } from "../../i18n";
import { WikiDiffView } from "./engineering-baseline-diff";
import { WikiMarkdown } from "./engineering-baseline-markdown";

export interface WikiEditorConflictInfo {
  revisionNumber: number;
  kind: string;
  createdAt: string;
  createdByType: string;
  createdById: string;
  changeSummary: string;
}

export type WikiSaveOutcome =
  | { status: "saved" }
  | { status: "conflict"; conflict: WikiEditorConflictInfo }
  | { status: "error" };

export interface WikiEditorProps {
  scope: "page" | "section";
  sectionTitle?: string;
  baseRevisionNumber: number;
  /** Latest published revision number, for the non-blocking "behind" notice. */
  latestRevisionNumber?: number;
  initialMarkdown: string;
  saving: boolean;
  actorName: (type: string, id: string) => string;
  onSave: (input: { markdown: string; changeSummary: string; sourceIssue: string; baseRevisionNumber: number }) => Promise<WikiSaveOutcome>;
  /** The user rebased the draft onto the conflicted current revision. */
  onRebase?: (baseRevisionNumber: number) => void;
  /** Current published content of the same scope, for the conflict diff. */
  fetchCurrentContent: () => Promise<string | null>;
  onCancel: () => void;
}

type ToolAction = "bold" | "code" | "h2" | "h3" | "ul" | "ol" | "codeblock" | "table" | "wikilink";

const TOOLBAR: readonly { action: ToolAction; labelKey: "toolbarBold" | "toolbarCode" | "toolbarH2" | "toolbarH3" | "toolbarUl" | "toolbarOl" | "toolbarCodeBlock" | "toolbarTable" | "toolbarWikilink"; icon: typeof Bold }[] = [
  { action: "bold", labelKey: "toolbarBold", icon: Bold },
  { action: "code", labelKey: "toolbarCode", icon: Code },
  { action: "h2", labelKey: "toolbarH2", icon: Heading2 },
  { action: "h3", labelKey: "toolbarH3", icon: Heading3 },
  { action: "ul", labelKey: "toolbarUl", icon: List },
  { action: "ol", labelKey: "toolbarOl", icon: ListOrdered },
  { action: "codeblock", labelKey: "toolbarCodeBlock", icon: Code },
  { action: "table", labelKey: "toolbarTable", icon: Table2 },
  { action: "wikilink", labelKey: "toolbarWikilink", icon: Link },
];
function applyTool(action: ToolAction, textarea: HTMLTextAreaElement | null, setValue: (value: string) => void) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);
  const emit = (insert: string, caret: number, caretEnd = caret) => {
    setValue(value.slice(0, start) + insert + value.slice(end));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + caret, start + caretEnd);
    });
  };
  switch (action) {
    case "bold": return emit(selected ? `**${selected}**` : `****`, 2, selected ? selected.length + 2 : 2);
    case "code": return emit(selected ? `\`${selected}\`` : "``", 1, selected ? selected.length + 1 : 1);
    case "h2": return emit(selected || "## 标题", 0);
    case "h3": return emit(selected || "### 标题", 0);
    case "ul": return emit(selected ? `- ${selected}` : "- ", 2);
    case "ol": return emit(selected ? `1. ${selected}` : "1. ", 3);
    case "codeblock": return emit(`\`\`\`\n${selected}\n\`\`\``, 4);
    case "table": return emit("| 列 | 列 |\n| --- | --- |\n|  |  |", 0);
    case "wikilink": return emit(selected ? `[[${selected}]]` : "[[]]", 2);
  }
}

export function WikiEditor(props: WikiEditorProps) {
  const { t } = useT("engineering");
  const [value, setValue] = useState(props.initialMarkdown);
  const [summary, setSummary] = useState("");
  const [sourceIssue, setSourceIssue] = useState("");
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [conflict, setConflict] = useState<WikiEditorConflictInfo | null>(null);
  const [base, setBase] = useState(props.baseRevisionNumber);
  const [conflictDiff, setConflictDiff] = useState<{ before: string; after: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const baseSnapshot = useRef(props.initialMarkdown);
  const dirty = value !== props.initialMarkdown;

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const behind = !conflict && props.latestRevisionNumber !== undefined && props.latestRevisionNumber > base;

  const save = async (baseRevisionNumber: number) => {
    if (!dirty) {
      toast.info(t(($) => $.wiki.editorNoChange));
      return;
    }
    const fallback = props.scope === "section" && props.sectionTitle
      ? t(($) => $.wiki.autoSummarySection, { title: props.sectionTitle })
      : t(($) => $.wiki.autoSummaryPage);
    const outcome = await props.onSave({
      markdown: value,
      changeSummary: summary.trim() || fallback,
      sourceIssue: sourceIssue.trim(),
      baseRevisionNumber,
    });
    if (outcome.status === "saved") {
      setConflict(null);
      setConflictDiff(null);
    } else if (outcome.status === "conflict") {
      setConflict(outcome.conflict);
      setBase(baseRevisionNumber);
    }
  };

  const loadConflictDiff = async () => {
    if (conflictDiff || !conflict) return;
    setDiffLoading(true);
    const current = await props.fetchCurrentContent();
    setDiffLoading(false);
    if (current === null) {
      toast.error(t(($) => $.wiki.conflictDiffUnavailable));
      return;
    }
    setConflictDiff({ before: baseSnapshot.current, after: current });
  };

  const rebaseOntoCurrent = () => {
    if (!conflict) return;
    const nextBase = conflict.revisionNumber;
    setBase(nextBase);
    setConflict(null);
    setConflictDiff(null);
    props.onRebase?.(nextBase);
  };

  return (
    <div className="rounded-md border" data-wiki-editor>
      {behind ? (
        <div className="border-b border-brand/40 bg-brand/5 px-3 py-2 text-caption text-foreground" data-wiki-editor-behind>
          {t(($) => $.wiki.editorBehind, { number: props.latestRevisionNumber ?? 0 })}
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t(($) => $.wiki.editorTabsLabel)}>
          {(["edit", "preview"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={cn("rounded-sm px-2.5 py-1 text-caption", tab === item ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              onClick={() => setTab(item)}
            >{t(($) => $.wiki.editorTab[item])}</button>
          ))}
        </div>
        {tab === "edit" ? (
          <div className="ml-auto flex flex-wrap items-center gap-0.5" role="toolbar" aria-label={t(($) => $.wiki.toolbarLabel)}>
            {TOOLBAR.map(({ action, labelKey, icon: Icon }) => (
              <button
                key={action}
                type="button"
                className="rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t(($) => $.wiki[labelKey])}
                title={t(($) => $.wiki[labelKey])}
                onClick={() => applyTool(action, textareaRef.current, setValue)}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {tab === "edit" ? (
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save(base);
            }
            if (event.key === "Tab") {
              event.preventDefault();
              const target = event.currentTarget;
              const next = `${target.value.slice(0, target.selectionStart)}  ${target.value.slice(target.selectionEnd)}`;
              setValue(next);
              requestAnimationFrame(() => target.setSelectionRange(target.selectionStart + 2, target.selectionStart + 2));
            }
          }}
          className="min-h-[200px] max-h-[560px] resize-y font-mono text-body"
          aria-label={t(($) => $.wiki.editorMarkdownLabel)}
          data-testid="wiki-editor-source"
        />
      ) : (
        <div className="max-h-[560px] overflow-y-auto px-4 py-3">
          {value.trim() ? <WikiMarkdown markdown={value} /> : <p className="text-caption text-muted-foreground">{t(($) => $.wiki.editorPreviewEmpty)}</p>}
        </div>
      )}
      <div className="grid gap-2 border-t px-3 py-2 sm:grid-cols-2">
        <Input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={t(($) => $.wiki.editorSummaryPlaceholder)} aria-label={t(($) => $.wiki.editorSummaryLabel)} />
        <Input value={sourceIssue} onChange={(event) => setSourceIssue(event.target.value)} placeholder={t(($) => $.wiki.editorIssuePlaceholder)} aria-label={t(($) => $.wiki.editorIssueLabel)} />
      </div>
      {conflict ? (
        <div className="border-t border-warning/50 bg-warning/5 px-3 py-3" data-testid="wiki-editor-conflict">
          <div className="font-medium">{t(($) => $.wiki.conflictTitle, { number: conflict.revisionNumber })}</div>
          <p className="mt-1 text-caption text-muted-foreground">
            {t(($) => $.wiki.conflictDescription, {
              name: props.actorName(conflict.createdByType, conflict.createdById),
              number: conflict.revisionNumber,
            })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void loadConflictDiff()}>{t(($) => $.wiki.conflictShowTheirs)}</Button>
            <Button type="button" size="sm" onClick={rebaseOntoCurrent}>{t(($) => $.wiki.conflictLoadCurrent)}</Button>
            <Button type="button" variant="outline" size="sm" disabled={props.saving} onClick={() => void save(conflict.revisionNumber)}>{t(($) => $.wiki.conflictOverwrite)}</Button>
          </div>
          {diffLoading ? <p className="mt-2 text-caption text-muted-foreground">{t(($) => $.wiki.conflictDiffLoading)}</p> : null}
          {conflictDiff ? <WikiDiffView className="mt-3 rounded-md bg-canvas p-2" before={conflictDiff.before} after={conflictDiff.after} /> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t px-3 py-2">
        <span className="min-w-0 flex-1 text-caption text-muted-foreground" data-wiki-editor-base>
          {t(($) => $.wiki.editorBaseNote, { number: base, next: base + 1 })}
        </span>
        {confirmDiscard && dirty ? (
          <>
            <span className="text-caption text-destructive">{t(($) => $.wiki.editorDiscardPrompt)}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>{t(($) => $.wiki.editorKeepEditing)}</Button>
            <Button type="button" variant="destructive" size="sm" onClick={props.onCancel}>{t(($) => $.wiki.editorDiscard)}</Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => (dirty ? setConfirmDiscard(true) : props.onCancel())}
            >{t(($) => $.wiki.editorCancel)}</Button>
            <Button type="button" size="sm" disabled={props.saving} onClick={() => void save(base)} data-testid="wiki-editor-save">
              {t(($) => $.wiki.editorSave)}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
