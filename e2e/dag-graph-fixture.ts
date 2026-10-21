import type { BrowserContext } from "@playwright/test";
import type { SyntheticIssueGraph } from "@multica/core/issues/testing/issue-graph-fixture";

export const WORKSPACE_SLUG = "perf";
export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const workspace = {
  id: WORKSPACE_ID, name: "Perf", slug: WORKSPACE_SLUG,
  description: null, context: null,
  settings: { github_enabled: false }, repos: [],
  issue_prefix: "GAME", avatar_url: null,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

const me = {
  id: USER_ID, name: "Perf User", email: "perf@example.test", avatar_url: null,
  language: null, onboarded_at: "2026-09-01T00:00:00Z",
  onboarding_questionnaire: { source: "other" },
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

/** Built-in status catalog so cards resolve colours and categories. */
const statuses = [
  { key: "backlog", name: "Backlog", category: "unstarted", color: "#94a3b8" },
  { key: "todo", name: "Todo", category: "unstarted", color: "#64748b" },
  { key: "in_progress", name: "In Progress", category: "started", color: "#3b82f6" },
  { key: "in_review", name: "In Review", category: "started", color: "#8b5cf6" },
  { key: "blocked", name: "Blocked", category: "started", color: "#f59e0b" },
  { key: "done", name: "Done", category: "done", color: "#22c55e" },
  { key: "cancelled", name: "Cancelled", category: "closed", color: "#ef4444" },
].map((status, index) => ({
  ...status,
  id: `s-${status.key}`,
  workspace_id: WORKSPACE_ID,
  description: "",
  icon: null,
  is_system: true,
  position: index,
  archived_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
}));

/** Detail shape for a graph node, for the toolbar's selection fetch. */
const issueDetail = (node: { id: string; identifier: string; title: string; status: string; priority: string }) => ({
  id: node.id, workspace_id: WORKSPACE_ID, number: 1,
  identifier: node.identifier, title: node.title,
  description: "Synthetic.", status: node.status,
  status_category: node.status, status_name: node.status, priority: node.priority,
  assignee_type: null, assignee_id: null, creator_type: "user", creator_id: USER_ID,
  parent_issue_id: null, project_id: null, position: 0,
  start_date: null, due_date: null, stage: null, metadata: {}, properties: {},
  labels: [], reactions: [],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
});

/** Real frontend with controlled HTTP/WebSocket data; never starts an agent. */
export async function mockDagGraph(
  context: BrowserContext,
  origin: string,
  graph: SyntheticIssueGraph,
  options: { preferences?: Record<string, unknown>; onGraph?: (bytes: number) => void; locale?: string; workspaceName?: string } = {},
) {
  const { onGraph } = options;
  const unknownRequests: string[] = [], external: string[] = [];
  const graphJson = JSON.stringify(graph);
  const details = new Map(graph.nodes.map((n) => [n.id, issueDetail(n)]));
  await context.addCookies([
    { name: "multica_logged_in", value: "1", url: origin },
    { name: "last_workspace_slug", value: WORKSPACE_SLUG, url: origin },
    { name: "multica-locale", value: options.locale ?? "en", url: origin },
  ]);
  await context.addInitScript(({ slug, preferences }) => {
    localStorage.setItem("multica:chat:floatingChatEnabled", "false");
    const key = `multica_issue_surface_views:${slug}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      state: { surfaces: { "workspace:all": { state: { viewMode: "dag", ...preferences }, updatedAt: "2026-10-15T00:00:00.000Z" } } }, version: 1,
    }));
  }, { slug: WORKSPACE_SLUG, preferences: options.preferences ?? {} });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === `/api/workspaces/${WORKSPACE_ID}/issues/graph`) {
      onGraph?.(Buffer.byteLength(graphJson));
      return route.fulfill({ status: 200, contentType: "application/json", body: graphJson });
    }
    const detail = /^\/api\/issues\/([0-9a-f-]+)$/.exec(url.pathname);
    if (detail && details.has(detail[1]!)) return route.fulfill(json(details.get(detail[1]!)));
    switch (url.pathname) {
      case "/api/config": return route.fulfill(json({ feature_flags: {}, allow_signup: true }));
      case "/api/me": return route.fulfill(json(me));
      case "/api/workspaces": return route.fulfill(json([{ ...workspace, name: options.workspaceName ?? workspace.name }]));
      case "/api/client-usage": return route.fulfill(json({}));
      case "/api/agents": case "/api/runtimes": case "/api/squads":
      case "/api/agent-task-snapshot": case "/api/invitations": case "/api/inbox":
      case "/api/inbox/unread-summary": case "/api/pins": case "/api/chat/sessions":
      case `/api/workspaces/${WORKSPACE_ID}/members`:
        return route.fulfill(json([]));
      case "/api/projects": return route.fulfill(json({ projects: [], total: 0 }));
      case "/api/issues": return route.fulfill(json({ issues: [], total: 0 }));
      // The issues surface also queries table rows/facets and saved views;
      // empty answers keep them off the DAG's critical path without 404 noise.
      case "/api/issues/table/rows":
      case "/api/issues/table/facets":
        return route.fulfill(json({ rows: [], total: 0, groups: [], facets: {} }));
      case "/api/issue-views": return route.fulfill(json({ views: [], total: 0 }));
      case "/api/issue-view-preferences":
      case "/api/notification-preferences":
        return route.fulfill(json({}));
      case "/api/issue-wakeup-summaries": return route.fulfill(json({ summaries: [] }));
      case "/api/issue-workflows": return route.fulfill(json({ workflows: [], total: 0 }));
      case "/api/search-index/manifest": return route.fulfill(json({}));
      case "/api/issue-statuses":
        return route.fulfill(json({ statuses, categories: ["unstarted", "started", "done", "closed"], total: statuses.length }));
      case "/api/properties": return route.fulfill(json({ properties: [], total: 0 }));
      case "/api/quick-actions": return route.fulfill(json({ quick_actions: [] }));
      case "/api/assignee-frequency": return route.fulfill(json([]));
      case "/api/issues/child-progress": return route.fulfill(json({ progress: [] }));
      default:
        unknownRequests.push(`${route.request().method()} ${url.pathname}`);
        return route.fulfill(json({}));
    }
  });
  // A stubbed socket keeps the realtime layer out of the numbers; the canvas
  // DOM proves liveness.
  await context.routeWebSocket((url) => url.pathname === "/ws", (ws) => {
    ws.onMessage(() => {});
  });

  return { unknownRequests, external };
}
