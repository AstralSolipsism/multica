"use client";

import { useQuery } from "@tanstack/react-query";
import type { Issue, UpdateIssueRequest } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { useIssueActions } from "../actions/use-issue-actions";
import { AssigneePicker } from "../components/pickers/assignee-picker";

/** One selected issue subscribes to detail/actions; graph nodes stay compact.
 *  A null id (the independent group has no backing issue) stays unsubscribed. */
export function useDagIssueSelection(issueId: string | null) {
  const wsId = useWorkspaceId();
  const detail = useQuery({ ...issueDetailOptions(wsId, issueId ?? ""), enabled: !!issueId });
  const issue = detail.isError ? null : (detail.data ?? null);
  const actions = useIssueActions(issue);
  return {
    issue,
    actions,
    detailFailed: !!issueId && detail.isError,
    retryDetail: () => void detail.refetch(),
  };
}

/** Assign action: the real picker once the detail has landed, a disabled
 *  placeholder while it loads. The menu variant opens the same picker
 *  controlled, anchored to a zero-size element next to the "more" trigger. */
export function DagAssignAction({
  issue,
  onUpdate,
  open,
  onOpenChange,
  anchor,
}: {
  issue: Issue | null;
  onUpdate: (updates: Partial<UpdateIssueRequest>) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Rendered as the picker anchor instead of the visible button (menu mode). */
  anchor?: React.ReactElement<Record<string, unknown>>;
}) {
  const { t } = useT("dag");
  if (!issue) {
    return (
      <Button size="sm" variant="ghost" disabled>
        {t(($) => $.assign_issue)}
      </Button>
    );
  }
  return (
    <AssigneePicker
      assigneeType={issue.assignee_type}
      assigneeId={issue.assignee_id}
      onUpdate={onUpdate}
      triggerRender={anchor ?? <Button size="sm" variant="ghost" />}
      trigger={anchor ? undefined : t(($) => $.assign_issue)}
      {...(open !== undefined ? { open, onOpenChange } : {})}
    />
  );
}
