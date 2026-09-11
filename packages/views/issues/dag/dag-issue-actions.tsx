"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import { useIssueActions } from "../actions/use-issue-actions";
import { AssigneePicker } from "../components/pickers/assignee-picker";

/** One selected issue subscribes to detail/actions; graph nodes stay compact. */
export function DagIssueActions({
  issueId,
  onOpenIssue,
}: {
  issueId: string;
  onOpenIssue: (issueId: string) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const detail = useQuery(issueDetailOptions(wsId, issueId));
  const issue = detail.isError ? null : (detail.data ?? null);
  const actions = useIssueActions(issue);

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onOpenIssue(issueId)}>
        {t(($) => $.dag.open_detail)}
      </Button>
      <Button size="sm" variant="ghost" disabled={!issue} onClick={actions.openEditDependencies}>
        {t(($) => $.dag.edit_dependencies)}
      </Button>
      {issue ? (
        <AssigneePicker
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
          onUpdate={actions.updateField}
          triggerRender={<Button size="sm" variant="ghost" />}
          trigger={t(($) => $.dag.assign_issue)}
        />
      ) : (
        <Button size="sm" variant="ghost" disabled>
          {t(($) => $.dag.assign_issue)}
        </Button>
      )}
      {detail.isError && (
        <Button size="sm" variant="ghost" onClick={() => void detail.refetch()}>
          {t(($) => $.dag.error_retry)}
        </Button>
      )}
    </>
  );
}
