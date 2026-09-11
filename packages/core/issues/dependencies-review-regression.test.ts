// @vitest-environment node
import { expect, it } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { createQueryClient } from "../query-client";
import { issueKeys } from "./queries";
import { onIssueUpdated } from "./ws-updaters";
import type { Issue } from "../types";

it("REVIEW refreshes a mounted prerequisite projection after its upstream changes", async () => {
  const client = createQueryClient();
  const key = issueKeys.dependencies("review-ws", "dependent");
  client.setQueryData(key, { unsatisfied: [] });
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => { reads += 1; return { unsatisfied: ["upstream"] }; },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const upstream: Issue = {
      id: "upstream", workspace_id: "review-ws", number: 1,
      identifier: "REV-1", title: "Prerequisite", description: null,
      status: "done", status_category: "done", priority: "none",
      assignee_type: null, assignee_id: null, creator_type: "member",
      creator_id: "review-user", parent_issue_id: null, project_id: null,
      position: 0, stage: null, start_date: null, due_date: null,
      metadata: {}, properties: {}, revision: 1,
      created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
    };
    client.setQueryData(issueKeys.detail("review-ws", "upstream"), upstream);
    onIssueUpdated(client, "review-ws", {
      ...upstream, status: "todo", status_category: "todo", revision: 2,
    }, { statusChanged: true });
    await Promise.resolve();
    expect(client.getQueryData<Issue>(issueKeys.detail("review-ws", "upstream"))?.status).toBe("todo");
    expect(reads, "The dependency sidebar must re-read after a prerequisite reopens").toBe(1);
  } finally {
    unsubscribe();
    client.clear();
  }
});
