/**
 * Shared mutable mock state and fixtures for the IssueDetail suites (OL-270).
 *
 * Plain module scope on purpose: `vi.hoisted` results cannot be exported,
 * and `vi.mock` factories in ./issue-detail.test-harness.tsx only touch these
 * bindings after this module has been evaluated (the harness imports it
 * first). No JSX, no `vi.mock` here.
 */
import { vi, type Mock } from "vitest";
import type { Issue, TimelineEntry } from "@multica/core/types";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

export const TEST_RESOURCES = { en: { agents: enAgents, common: enCommon, issues: enIssues } };

export const mockViewport = { isMobile: false };

// Counts MockContentEditor mounts. This pins the description to exactly one
// eager editor per issue and catches stale editor reuse across issue switches.
export const contentEditorMounts = { count: 0 };
// Every ReadonlyContent render, by content. A comment card renders its body
// through it, so this counts card renders without reaching into the card.
export const readonlyContentRenders: string[] = [];
export const descriptionSelectionAction: {
  current: { label: string; onSelect: () => void } | undefined;
} = { current: undefined };
// Stable empty-attachments reference: the real store returns a shared constant
// so the `useCommentDraftStore(s => s.getAttachments(key))` selector keeps a
// stable identity. A fresh `[]` per call would loop useSyncExternalStore.
export const emptyDraftAttachments: unknown[] = [];

// The YSK archive mount must keep passing the timeline jump helper; when
// this line disappears in an upstream merge, group jumps silently fall back
// to the unreliable URL navigation (OL-269). Capture props instead of
// rendering so the assertion does not depend on the section's own gating.
export const archiveSectionProps: { current: unknown } = { current: null };

export const mockAuthUser = { id: "user-1", email: "test@test.com", name: "Test User" };

export const mockRecordVisit: Mock = vi.fn();

// scrollIntoViewSpy: the deep-link landing no longer calls native
// scrollIntoView (it drives the timeline container's scrollTop directly to
// avoid scrolling ancestor overflow:hidden boxes — see issue-detail.tsx). A
// no-op stub on the prototype keeps stray scrollIntoView calls from other
// components from throwing; deep-link tests assert the highlight background
// instead, which is mechanism-independent and observable without layout.
export const scrollIntoViewSpy: Mock = vi.fn();
export const scrollToIndexSpy: Mock = vi.fn();

export const mockOpenModal: Mock = vi.fn();

export interface MockApi {
  getIssue: Mock;
  listTimeline: Mock;
  listComments: Mock;
  createComment: Mock;
  updateComment: Mock;
  deleteComment: Mock;
  deleteIssue: Mock;
  updateIssue: Mock;
  listIssueSubscribers: Mock;
  subscribeToIssue: Mock;
  unsubscribeFromIssue: Mock;
  unsubscribeFromIssueSubtree: Mock;
  getActiveTasksForIssue: Mock;
  listTasksByIssue: Mock;
  rerunIssue: Mock;
  listTaskMessages: Mock;
  listChildIssues: Mock;
  getChildIssueProgress: Mock;
  getAgentTaskSnapshot: Mock;
  getWorkspaceWorkingAgents: Mock;
  listProperties: Mock;
  listIssues: Mock;
  uploadFile: Mock;
  listIssueReactions: Mock;
  addIssueReaction: Mock;
  removeIssueReaction: Mock;
  listAttachments: Mock;
  addCommentReaction: Mock;
  removeCommentReaction: Mock;
  listMembers: Mock;
  listAgents: Mock;
  getAgent: Mock;
  listRuntimes: Mock;
  getProject: Mock;
  listProjects: Mock;
}

export const mockApiObj: MockApi = {
  getIssue: vi.fn(),
  listTimeline: vi.fn().mockResolvedValue([]),
  listComments: vi.fn().mockResolvedValue([]),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  deleteIssue: vi.fn(),
  updateIssue: vi.fn(),
  listIssueSubscribers: vi.fn().mockResolvedValue([]),
  subscribeToIssue: vi.fn().mockResolvedValue(undefined),
  unsubscribeFromIssue: vi.fn().mockResolvedValue(undefined),
  unsubscribeFromIssueSubtree: vi.fn().mockResolvedValue(undefined),
  getActiveTasksForIssue: vi.fn().mockResolvedValue({ tasks: [] }),
  listTasksByIssue: vi.fn().mockResolvedValue([]),
  rerunIssue: vi.fn(),
  listTaskMessages: vi.fn().mockResolvedValue([]),
  listChildIssues: vi.fn().mockResolvedValue({ issues: [] }),
  getChildIssueProgress: vi.fn().mockResolvedValue({ progress: [] }),
  getAgentTaskSnapshot: vi.fn().mockResolvedValue([]),
  // The sub-issues header chip reads this narrowed to the parent issue.
  getWorkspaceWorkingAgents: vi.fn().mockResolvedValue([]),
  listProperties: vi.fn().mockResolvedValue({ properties: [], total: 0 }),
  listIssues: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
  uploadFile: vi.fn(),
  listIssueReactions: vi.fn().mockResolvedValue([]),
  addIssueReaction: vi.fn(),
  removeIssueReaction: vi.fn(),
  listAttachments: vi.fn().mockResolvedValue([]),
  addCommentReaction: vi.fn(),
  removeCommentReaction: vi.fn(),
  listMembers: vi.fn().mockResolvedValue([{ user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" }]),
  listAgents: vi.fn().mockResolvedValue([]),
  getAgent: vi.fn().mockResolvedValue(null),
  listRuntimes: vi.fn().mockResolvedValue([]),
  getProject: vi.fn(),
  listProjects: vi.fn().mockResolvedValue({ projects: [] }),
};

export const mockIssue: Issue = {
  id: "issue-1",
  workspace_id: "ws-1",
  number: 1,
  identifier: "TES-1",
  title: "Implement authentication",
  description: "Add JWT auth to the backend",
  status: "in_progress",
  priority: "high",
  assignee_type: "member",
  assignee_id: "user-1",
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: null,
  position: 0,
  stage: null,
  start_date: null,
  due_date: "2026-06-01T00:00:00Z",
  metadata: {},
  properties: {},
  created_at: "2026-01-15T00:00:00Z",
  updated_at: "2026-01-20T00:00:00Z",
  revision: 3,
};

export const mockTimeline: TimelineEntry[] = [
  {
    type: "comment",
    id: "comment-1",
    actor_type: "member",
    actor_id: "user-1",
    content: "Started working on this",
    parent_id: null,
    created_at: "2026-01-16T00:00:00Z",
    updated_at: "2026-01-16T00:00:00Z",
    comment_type: "comment",
  },
  {
    type: "comment",
    id: "comment-2",
    actor_type: "agent",
    actor_id: "agent-1",
    content: "I can help with this",
    parent_id: null,
    created_at: "2026-01-17T00:00:00Z",
    updated_at: "2026-01-17T00:00:00Z",
    comment_type: "comment",
  },
];
