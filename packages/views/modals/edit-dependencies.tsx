"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@multica/ui/components/ui/command";
import { api, clientErrorMessage, dependencyErrorDetails } from "@multica/core/api";
import type { IssuePrerequisite } from "@multica/core/api";
import { issueStatusCategory } from "@multica/core/issues";
import { issueDependenciesOptions, issueDetailOptions, issueKeys } from "@multica/core/issues/queries";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useModalStore } from "@multica/core/modals";
import type { Issue } from "@multica/core/types";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";
import { StatusIcon } from "../issues/components/status-icon";
import { PrerequisiteList } from "../issues/components/dependency-prerequisites";

/** The editable form of a direct prerequisite. Items hydrated from the
 *  server projection carry their real edge metadata; freshly picked issues
 *  have no edge yet (sourceEdges stays empty — it is display-only here). */
type EditablePrerequisite = IssuePrerequisite;

function fromProjection(p: IssuePrerequisite): EditablePrerequisite {
  return p;
}

function fromPickedIssue(issue: Issue): EditablePrerequisite {
  const category = issueStatusCategory(issue) ?? issue.status_category ?? "";
  return {
    issueId: issue.id,
    status: issue.status,
    statusCategory: category,
    satisfied: category === "done",
    sourceEdges: [],
    inheritedFrom: [],
    title: issue.title,
    identifier: issue.identifier,
    descendantCount: undefined,
  };
}

function sortedIds(view: { blockedBy: IssuePrerequisite[] }): string[] {
  return view.blockedBy.map((p) => p.issueId).sort();
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

type Notice =
  | { kind: "conflict" }
  | { kind: "structure" }
  | { kind: "permission" }
  | { kind: "unverified" }
  | { kind: "generic"; message?: string };

/**
 * The shared prerequisite editor (OL-44): one dialog for the detail sidebar,
 * the Relations menu, and the DAG node's edit callback. Only DIRECT
 * `blocked_by` edges are edited here — replacing the set is a single compound
 * `with-dependencies` write guarded by the dependency version the user
 * reviewed, so a concurrent edit surfaces as a conflict refresh instead of a
 * silent overwrite. Inherited constraints are listed read-only with a jump to
 * the source ancestor's editor; weakening them here would bypass the rule
 * that inheritance is resolved at the source edge.
 */
export function EditDependenciesModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const issueId = typeof data?.issueId === "string" ? data.issueId : null;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      {issueId ? (
        <EditDependenciesBody key={issueId} issueId={issueId} onClose={onClose} />
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle />
          </DialogHeader>
        </DialogContent>
      )}
    </Dialog>
  );
}

function EditDependenciesBody({
  issueId,
  onClose,
}: {
  issueId: string;
  onClose: () => void;
}) {
  const { t } = useT("modals");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const openModal = useModalStore((s) => s.open);
  const qc = useQueryClient();
  const updateIssue = useUpdateIssue();

  const { data: issue } = useQuery(issueDetailOptions(wsId, issueId));
  const depsQuery = useQuery(issueDependenciesOptions(wsId, issueId));
  const view = depsQuery.data ?? null;

  // Form state is hydrated from the projection the user is looking at; the
  // version it carries is the compare-and-swap token the save echoes back.
  const [form, setForm] = useState<{
    version: string;
    baselineIds: string[];
    selected: Map<string, EditablePrerequisite>;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!view) return;
    setForm((prev) => {
      if (prev && prev.version === view.dependencyVersion) return prev;
      const hydrated = {
        version: view.dependencyVersion,
        baselineIds: sortedIds(view),
        selected: new Map(view.blockedBy.map((p) => [p.issueId, fromProjection(p)])),
      };
      if (!prev) return hydrated;
      // An untouched form just tracks the server's latest projection; a form
      // with pending edits keeps them — the save then answers any version
      // drift with an explicit conflict instead of a silent clobber.
      const dirty = !sameIdSet([...prev.selected.keys()], prev.baselineIds);
      return dirty ? prev : hydrated;
    });
  }, [view]);

  const dirty =
    !!form && !sameIdSet([...form.selected.keys()], form.baselineIds);

  // --- search (workspace-wide, cross-project — same endpoint the other
  // issue pickers use) -------------------------------------------------------
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Issue[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (!q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await api.searchIssues({
          q: q.trim(),
          limit: 20,
          include_closed: true,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setResults(res.issues);
          setSearching(false);
        }
      } catch {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
  }, []);

  const inheritedIds = useMemo(
    () => new Set((view?.inheritedBlockedBy ?? []).map((p) => p.issueId)),
    [view],
  );

  const addPrerequisite = useCallback((picked: Issue) => {
    setNotice(null);
    setForm((prev) => {
      if (!prev || prev.selected.has(picked.id)) return prev;
      const selected = new Map(prev.selected);
      selected.set(picked.id, fromPickedIssue(picked));
      return { ...prev, selected };
    });
  }, []);

  const removePrerequisite = useCallback((p: IssuePrerequisite) => {
    setNotice(null);
    setForm((prev) => {
      if (!prev || !prev.selected.has(p.issueId)) return prev;
      const selected = new Map(prev.selected);
      selected.delete(p.issueId);
      return { ...prev, selected };
    });
  }, []);

  const openIssue = useCallback(
    (targetId: string) => {
      // Locating a prerequisite leaves the editor: unsaved edits are cheap to
      // redo, and an editor floating over a different issue's page is not.
      navigation.push(paths.issueDetail(targetId));
      onClose();
    },
    [navigation, paths, onClose],
  );

  const openSource = useCallback(
    (ancestorId: string) => {
      // Inheritance is resolved at the source edge: swap the editor to the
      // ancestor the constraint arrives through (same dialog, fresh target).
      openModal("issue-edit-dependencies", { issueId: ancestorId });
    },
    [openModal],
  );

  const canSave =
    !!form && dirty && !saving && !depsQuery.isLoading && depsQuery.data !== null;

  const save = async () => {
    if (!form || !canSave) return;
    setSaving(true);
    setNotice(null);
    try {
      await updateIssue.mutateAsync({
        id: issueId,
        blockedBy: [...form.selected.keys()].sort(),
        expectedDependencyVersion: form.version,
      });
      toast.success(t(($) => $.edit_dependencies.toast_saved));
      onClose();
    } catch (err) {
      const details = dependencyErrorDetails(err);
      switch (details?.reasonCode) {
        case "dependency_version_conflict": {
          // Someone else edited first: re-base onto the projection the server
          // just sent (or a refetch), keep the user's selection, and say so.
          setNotice({ kind: "conflict" });
          const fresh =
            details.dependencies ??
            (await depsQuery.refetch()).data ??
            null;
          if (fresh) {
            qc.setQueryData(issueKeys.dependencies(wsId, issueId), fresh);
            setForm((prev) =>
              prev
                ? {
                    version: fresh.dependencyVersion,
                    baselineIds: sortedIds(fresh),
                    selected: prev.selected,
                  }
                : prev,
            );
          }
          break;
        }
        case "dependency_cycle":
        case "dependency_ancestor_conflict":
          setNotice({ kind: "structure" });
          break;
        case "dependency_change_not_allowed":
          setNotice({ kind: "permission" });
          break;
        case "dependency_data_unverified":
          setNotice({ kind: "unverified" });
          break;
        default:
          setNotice({ kind: "generic", message: clientErrorMessage(err) });
      }
    } finally {
      setSaving(false);
    }
  };

  const inherited = view?.inheritedBlockedBy ?? [];
  const selectedItems = form ? [...form.selected.values()] : [];
  const malformed = depsQuery.isSuccess && depsQuery.data === null;

  return (
    <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
      <DialogHeader className="shrink-0 px-4 pt-4 pb-3">
        <DialogTitle>{t(($) => $.edit_dependencies.title)}</DialogTitle>
        <DialogDescription>
          {issue
            ? t(($) => $.edit_dependencies.description_for, {
                identifier: issue.identifier,
              })
            : t(($) => $.edit_dependencies.description)}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
        {notice && (
          <Alert variant={notice.kind === "conflict" ? "default" : "destructive"}>
            <AlertDescription>
              {notice.kind === "conflict" && t(($) => $.edit_dependencies.conflict_notice)}
              {notice.kind === "structure" && t(($) => $.edit_dependencies.error_structure)}
              {notice.kind === "permission" && t(($) => $.edit_dependencies.error_permission)}
              {notice.kind === "unverified" && t(($) => $.edit_dependencies.error_unverified)}
              {notice.kind === "generic" &&
                (notice.message ?? t(($) => $.edit_dependencies.error_generic))}
            </AlertDescription>
          </Alert>
        )}

        {depsQuery.isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        )}

        {(depsQuery.isError || malformed) && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-body text-muted-foreground">
              {malformed
                ? t(($) => $.edit_dependencies.unknown_state)
                : t(($) => $.edit_dependencies.load_error)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void depsQuery.refetch()}
            >
              {t(($) => $.edit_dependencies.retry)}
            </Button>
          </div>
        )}

        {view && form && (
          <>
            <div>
              <div className="mb-1 px-2 text-micro font-medium text-muted-foreground">
                {t(($) => $.edit_dependencies.direct_section)}
              </div>
              {selectedItems.length === 0 ? (
                <p className="px-2 py-1.5 text-caption text-muted-foreground">
                  {t(($) => $.edit_dependencies.empty_direct)}
                </p>
              ) : (
                <PrerequisiteList
                  wsId={wsId}
                  items={selectedItems}
                  onOpen={openIssue}
                  onRemove={removePrerequisite}
                  removeDisabled={saving}
                />
              )}
            </div>

            {(inherited.length > 0 || view.hasRestrictedBlockers) && (
              <div>
                <div className="mb-1 px-2 text-micro font-medium text-muted-foreground">
                  {t(($) => $.edit_dependencies.inherited_section)}
                </div>
                {inherited.length > 0 && (
                  <PrerequisiteList
                    wsId={wsId}
                    items={inherited}
                    mode="inherited"
                    onOpen={openIssue}
                    onEditSource={openSource}
                  />
                )}
                {view.hasRestrictedBlockers && (
                  <p className="px-2 py-1.5 text-caption text-muted-foreground">
                    {t(($) => $.edit_dependencies.restricted_note)}
                  </p>
                )}
                <p className="px-2 py-1 text-micro text-muted-foreground">
                  {t(($) => $.edit_dependencies.inherited_hint)}
                </p>
              </div>
            )}

            <div>
              <Command shouldFilter={false} className="rounded-md border">
                <CommandInput
                  placeholder={t(($) => $.issue_picker.search_placeholder)}
                  value={query}
                  onValueChange={(v) => {
                    setQuery(v);
                    search(v);
                  }}
                />
                <CommandList>
                  {searching && (
                    <div className="py-4 text-center text-caption text-muted-foreground">
                      {t(($) => $.issue_picker.searching)}
                    </div>
                  )}
                  {!searching && query.trim() && results.length === 0 && (
                    <CommandEmpty>{t(($) => $.issue_picker.no_results)}</CommandEmpty>
                  )}
                  {!searching && !query.trim() && (
                    <div className="py-4 text-center text-caption text-muted-foreground">
                      {t(($) => $.issue_picker.prompt_to_search)}
                    </div>
                  )}
                  {results.length > 0 && (
                    <CommandGroup>
                      {results.map((result) => {
                        const isSelf = result.id === issueId;
                        const isSelected = form.selected.has(result.id);
                        const isInherited = inheritedIds.has(result.id);
                        const disabled = isSelf || isSelected || isInherited;
                        return (
                          <CommandItem
                            key={result.id}
                            value={result.id}
                            disabled={disabled}
                            onSelect={() => addPrerequisite(result)}
                          >
                            <StatusIcon
                              status={result.status}
                              category={issueStatusCategory(result) ?? undefined}
                              className="h-3.5 w-3.5 shrink-0"
                            />
                            <span className="shrink-0 text-muted-foreground">
                              {result.identifier}
                            </span>
                            <span className="truncate">{result.title}</span>
                            {isSelf && (
                              <span className="ml-auto shrink-0 text-micro text-muted-foreground">
                                {t(($) => $.edit_dependencies.self_badge)}
                              </span>
                            )}
                            {isSelected && (
                              <span className="ml-auto shrink-0 text-micro text-muted-foreground">
                                {t(($) => $.edit_dependencies.added_badge)}
                              </span>
                            )}
                            {isInherited && !isSelected && (
                              <span className="ml-auto shrink-0 text-micro text-muted-foreground">
                                {t(($) => $.edit_dependencies.inherited_badge)}
                              </span>
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </div>
          </>
        )}
      </div>

      <DialogFooter className="shrink-0 border-t px-4 py-3">
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
          {t(($) => $.edit_dependencies.cancel)}
        </Button>
        <Button type="button" disabled={!canSave} onClick={() => void save()}>
          {saving ? <Spinner className="size-4" /> : t(($) => $.edit_dependencies.save)}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
