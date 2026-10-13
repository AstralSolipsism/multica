import { forwardRef, useEffect, useRef, useState, useImperativeHandle } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, TimelineEntry } from "@multica/core/types";
import { issueKeys } from "@multica/core/issues/queries";
import { I18nProvider } from "@multica/core/i18n/react";
import { useResolvedExpandStore } from "@multica/core/issues/stores/resolved-expand-store";
import { useCommentCollapseStore } from "@multica/core/issues/stores";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { agents: enAgents, common: enCommon, issues: enIssues } };

const mockViewport = vi.hoisted(() => ({ isMobile: false }));

// Counts MockContentEditor mounts. This pins the description to exactly one
// eager editor per issue and catches stale editor reuse across issue switches.
const contentEditorMounts = vi.hoisted(() => ({ count: 0 }));
// Every ReadonlyContent render, by content. A comment card renders its body
// through it, so this counts card renders without reaching into the card.
const readonlyContentRenders = vi.hoisted(() => [] as string[]);
const descriptionSelectionAction = vi.hoisted(() => ({ current: undefined as { label: string; onSelect: () => void } | undefined }));
// Stable empty-attachments reference: the real store returns a shared constant
// so the `useCommentDraftStore(s => s.getAttachments(key))` selector keeps a
// stable identity. A fresh `[]` per call would loop useSyncExternalStore.
const emptyDraftAttachments = vi.hoisted(() => [] as unknown[]);

vi.mock("@multica/ui/hooks/use-mobile", () => ({
  useIsMobile: () => mockViewport.isMobile,
}));

// useWorkspaceId() derives from useCurrentWorkspace (relative import inside
// @multica/core/hooks.tsx). vi.mock("@multica/core/paths") only intercepts
// the bare-specifier, not the internal relative import. Mock the hooks module
// directly so the bridge hook returns the test UUID.
vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// The YSK archive mount must keep passing the timeline jump helper; when
// this line disappears in an upstream merge, group jumps silently fall back
// to the unreliable URL navigation (OL-269). Capture props instead of
// rendering so the assertion does not depend on the section's own gating.
const archiveSectionProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../you-should-know/archive/archive-section", () => ({
  YouShouldKnowArchiveSection: (props: unknown) => {
    archiveSectionProps.current = props;
    return null;
  },
}));

vi.mock("./issue-dependencies-section", () => ({
  IssueDependenciesSection: ({ issue }: { issue: { id: string } }) => (
    <div data-testid="issue-dependencies-section" data-issue-id={issue.id} />
  ),
}));

// Mock @multica/core/auth
const mockAuthUser = { id: "user-1", email: "test@test.com", name: "Test User" };
vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = { user: mockAuthUser, isAuthenticated: true };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ user: mockAuthUser, isAuthenticated: true }) },
  ),
  registerAuthStore: vi.fn(),
  createAuthStore: vi.fn(),
}));

// Mock @multica/core/workspace/hooks
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getMemberName: (id: string) => (id === "user-1" ? "Test User" : "Unknown"),
    getAgentName: (id: string) => (id === "agent-1" ? "Claude Agent" : "Unknown Agent"),
    getActorName: (type: string, id: string) => {
      if (type === "member" && id === "user-1") return "Test User";
      if (type === "agent" && id === "agent-1") return "Claude Agent";
      return "Unknown";
    },
    getActorInitials: (type: string) => (type === "member" ? "TU" : "CA"),
    getActorAvatarUrl: () => null,
  }),
}));

// Mock workspace queries
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({
    queryKey: ["workspaces", "ws-1", "members"],
    queryFn: () => Promise.resolve([{ user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" }]),
  }),
  agentListOptions: () => ({
    queryKey: ["workspaces", "ws-1", "agents"],
    queryFn: () => Promise.resolve([]),
  }),
  squadListOptions: () => ({
    queryKey: ["workspaces", "ws-1", "squads"],
    queryFn: () => Promise.resolve([]),
  }),
  assigneeFrequencyOptions: () => ({
    queryKey: ["workspaces", "ws-1", "assignee-frequency"],
    queryFn: () => Promise.resolve([]),
  }),
  workspaceListOptions: () => ({
    queryKey: ["workspaces"],
    queryFn: () => Promise.resolve([{ id: "ws-1", name: "Test WS", slug: "test" }]),
  }),
}));

// Mock @multica/core/paths — after the URL-driven workspace refactor,
// useCurrentWorkspace / useWorkspacePaths derive from the workspace slug in
// URL Context. Tests don't mount a real route, so we short-circuit to fixtures.
vi.mock("@multica/core/paths", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/paths")>(
    "@multica/core/paths",
  );
  return {
    ...actual,
    useCurrentWorkspace: () => ({ id: "ws-1", name: "Test WS", slug: "test" }),
    useWorkspacePaths: () => actual.paths.workspace("test"),
  };
});

// Mock navigation — REVIEW: injectable adapter so a web-like shell can drive it.
vi.mock("../../navigation", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const Ctx = React.createContext<any>(null);
  return {
    AppLink: ({ children, href, ...props }: any) => (
      <a href={href} {...props}>
        {children}
      </a>
    ),
    useNavigation: () =>
      React.useContext(Ctx) ?? {
        push: vi.fn(),
        pathname: "/issues/issue-1",
        getShareableUrl: (p: string) => `https://app.multica.com${p}`,
      },
    useBackOrReplace: () => vi.fn(),
    NavigationProvider: ({ value, children }: { value: unknown; children: React.ReactNode }) =>
      React.createElement(Ctx.Provider, { value }, children),
  };
});

// Mock editor components (Tiptap requires real DOM)
vi.mock("../../editor", async () => ({
  // Real lazy-mount controller (pure React, no Tiptap) so readonly-first
  // shell → activate → ready flows behave exactly as in production.
  ...(await vi.importActual<typeof import("../../editor/use-lazy-editor")>(
    "../../editor/use-lazy-editor",
  )),
  // Real submit gate (pure React) — see comment-composers.test.tsx.
  ...(await vi.importActual<typeof import("../../editor/use-upload-gate")>(
    "../../editor/use-upload-gate",
  )),
  // Real await-then-render submit hook (pure React) so comment/reply/edit
  // composers run the production submit path.
  ...(await vi.importActual<typeof import("../../editor/use-composer-submit")>(
    "../../editor/use-composer-submit",
  )),
  useEditorUpload: () => ({
    uploadWithToast: vi.fn(),
    upload: vi.fn(),
    uploading: false,
  }),
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
  FileDropOverlay: () => null,
  // No-op so comment-card's AttachmentList can render without hitting the
  // real API singleton; tests that care about download wiring should write
  // dedicated specs against `use-download-attachment.test.tsx`.
  useDownloadAttachment: () => vi.fn(),
  // Inert preview hook — comment-card's AttachmentList uses it to gate the
  // Eye button. Dedicated coverage lives in attachment-preview-modal.test.tsx.
  useAttachmentPreview: () => ({
    open: vi.fn(),
    tryOpen: () => false,
    modal: null,
  }),
  // Pass-through: the detail page wraps its column in the preview-sequence
  // provider, but paging between files is covered in
  // preview-sequence-context.test.tsx against the real provider.
  PreviewSequenceProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  usePreviewSequence: () => ({ openAt: () => false }),
  collectPreviewSequence: () => [],
  // Comment attachments render as their filename — the viewer and file cards
  // have their own suites.
  AttachmentDownloadProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  Attachment: ({ attachment }: { attachment: { filename?: string } }) => (
    <span data-testid="comment-attachment">{attachment.filename}</span>
  ),
  isPreviewable: () => false,
  ReadonlyContent: ({ content }: { content: string }) => {
    readonlyContentRenders.push(content);
    return <div data-testid="readonly-content">{content}</div>;
  },
  ContentEditor: forwardRef(function MockContentEditor(
    {
      defaultValue,
      value: syncedValue,
      onUpdate,
      placeholder,
      flushPendingOnUnmount,
      onReady,
      selectionAction,
    }: any,
    ref: any,
  ) {
    const initialValue = syncedValue ?? defaultValue ?? "";
    if (syncedValue !== undefined) descriptionSelectionAction.current = selectionAction;
    const valueRef = useRef(initialValue);
    const baseRef = useRef(initialValue);
    const [editorValue, setEditorValue] = useState(initialValue);
    // Mirrors the real editor's dirty guard: once the user has typed, an
    // external `value` change is refused so it cannot clobber unsaved bytes.
    // Only the imperative adoptContent channel lands after that point.
    const dirtyRef = useRef(false);
    useEffect(() => {
      contentEditorMounts.count += 1;
      onReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
      if (syncedValue === undefined || dirtyRef.current) return;
      valueRef.current = syncedValue;
      baseRef.current = syncedValue;
      setEditorValue(syncedValue);
    }, [syncedValue]);
    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      clearContent: () => {
        valueRef.current = "";
        dirtyRef.current = false;
        setEditorValue("");
      },
      // The real handle applies content the `value` prop cannot land (a dirty
      // editor refuses external syncs) and does so without emitting an update.
      adoptContent: (markdown: string) => {
        valueRef.current = markdown;
        baseRef.current = markdown;
        dirtyRef.current = false;
        setEditorValue(markdown);
      },
      focus: () => {},
      focusAtCoords: () => {},
      // The top-level composer blurs after a posted comment (afterAccepted).
      blur: () => {},
      // Read by the submit-time upload gate; no uploads are exercised here.
      hasActiveUploads: () => false,
      // Placeholder rebuild contract: the real handle draws a card for an
      // upload the document is not showing and reports whether it landed.
      // Mocks track ids only — no document to draw into.
      insertUploadPlaceholder: () => true,
      settleUploadPlaceholder: () => false,
      uploadFile: () => {},
    }));
    return (
      <textarea
        value={editorValue}
        onChange={(e) => {
          valueRef.current = e.target.value;
          dirtyRef.current = true;
          setEditorValue(e.target.value);
          onUpdate?.(e.target.value, baseRef.current);
        }}
        placeholder={placeholder}
        data-testid="rich-text-editor"
        data-flush-on-unmount={flushPendingOnUnmount ? "true" : undefined}
      />
    );
  }),
  TitleEditor: forwardRef(function MockTitleEditor(
    { defaultValue, placeholder, onBlur, onChange, onReady }: any,
    ref: any,
  ) {
    const valueRef = useRef(defaultValue || "");
    const [value, setValue] = useState(defaultValue || "");
    useEffect(() => {
      onReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useImperativeHandle(ref, () => ({
      getText: () => valueRef.current,
      focus: () => {},
      focusAtCoords: () => {},
    }));
    return (
      <input
        value={value}
        onChange={(e) => {
          valueRef.current = e.target.value;
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        onBlur={() => onBlur?.(valueRef.current)}
        placeholder={placeholder}
        data-testid="title-editor"
      />
    );
  }),
}));

// Mock common components
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: any) => (
    <span data-testid="actor-avatar">
      {actorType}:{actorId}
    </span>
  ),
}));

vi.mock("../../projects/components/project-picker", () => ({
  ProjectPicker: () => <span data-testid="project-picker">Project</span>,
}));

// Mock api
const mockApiObj = vi.hoisted(() => ({
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
}));

vi.mock("@multica/core/api", () => ({
  api: mockApiObj,
  getApi: () => mockApiObj,
  setApiInstance: vi.fn(),
  errorCode: (error: unknown) =>
    typeof error === "object" && error !== null && "body" in error
      ? (error as { body?: { code?: string } }).body?.code
      : undefined,
}));

// Mock issue config
// Use the real status configuration so category fixtures cannot drift.

// Mock recent issues store
const mockRecordVisit = vi.fn();
vi.mock("@multica/core/issues/stores", async () => ({
  // Real store, not a stub: resolved-thread expand/collapse behavior under
  // test runs through it. Deep import keeps the persisted sibling stores
  // (which need localStorage) out of this mock.
  ...(await vi.importActual<
    typeof import("@multica/core/issues/stores/resolved-expand-store")
  >("@multica/core/issues/stores/resolved-expand-store")),
  // Real store: sub-issue display tests drive it with setState, and the
  // component reads it through the barrel — both must hit the same instance.
  ...(await vi.importActual<
    typeof import("@multica/core/issues/stores/sub-issue-display-store")
  >("@multica/core/issues/stores/sub-issue-display-store")),
  // Real store, in-memory (no localStorage): backs the sub-issues section's
  // collapsed state.
  ...(await vi.importActual<
    typeof import("@multica/core/issues/stores/sub-issues-collapse-store")
  >("@multica/core/issues/stores/sub-issues-collapse-store")),
  useRecentIssuesStore: Object.assign(
    (selector?: any) => {
      const state = { byWorkspace: {}, recordVisit: mockRecordVisit, pruneWorkspaces: vi.fn() };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        byWorkspace: {},
        recordVisit: mockRecordVisit,
        pruneWorkspaces: vi.fn(),
      }),
    },
  ),
  selectRecentIssues: () => () => [],
  // Reactive in-memory stand-in: a quick-jump to a reply reopens a thread the
  // reader collapsed, so the card has to re-render when `toggle` runs.
  useCommentCollapseStore: (await vi.importActual<typeof import("zustand")>("zustand")).create<{
    collapsedByIssue: Record<string, string[]>;
    isCollapsed: (issueId: string, commentId: string) => boolean;
    toggle: (issueId: string, commentId: string) => void;
  }>()((set, get) => ({
    collapsedByIssue: {},
    isCollapsed: (issueId, commentId) => get().collapsedByIssue[issueId]?.includes(commentId) ?? false,
    toggle: (issueId, commentId) =>
      set((s) => {
        const current = s.collapsedByIssue[issueId] ?? [];
        return {
          collapsedByIssue: {
            ...s.collapsedByIssue,
            [issueId]: current.includes(commentId)
              ? current.filter((c) => c !== commentId)
              : [...current, commentId],
          },
        };
      }),
  })),
  useCommentDraftStore: Object.assign(
    (selector?: any) => {
      const state = {
        drafts: {} as Record<string, { content: string; attachments: unknown[]; updatedAt: number }>,
        getDraft: () => undefined,
        getAnnotations: () => emptyDraftAttachments,
        getAttachments: () => emptyDraftAttachments,
        getUploads: () => emptyDraftAttachments,
        setDraft: () => {},
        setAttachments: () => {},
        addUpload: () => {},
        settleUpload: () => {},
        failUpload: () => {},
        removeUpload: () => {},
        clearDraft: () => {},
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        drafts: {} as Record<string, { content: string; attachments: unknown[]; updatedAt: number }>,
        getDraft: () => undefined,
        getAnnotations: () => emptyDraftAttachments,
        getAttachments: () => emptyDraftAttachments,
        getUploads: () => emptyDraftAttachments,
        setDraft: () => {},
        setAttachments: () => {},
        addUpload: () => {},
        settleUpload: () => {},
        failUpload: () => {},
        removeUpload: () => {},
        clearDraft: () => {},
      }),
    },
  ),
  useCommentComposerStore: Object.assign(
    (selector?: any) => {
      const state = { sticky: true, runningAgentReply: "steer", toggleSticky: () => {} };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ sticky: true, runningAgentReply: "steer", toggleSticky: () => {} }),
    },
  ),
}));

// Mock react-virtuoso: jsdom has no real layout, so the real Virtuoso would
// compute a 0-height viewport and render nothing. The mock renders every item
// inline so id="comment-..." nodes are always present in the DOM — this
// matches the production cold-path where `initialItemCount` force-mounts
// items[0..targetIdx], giving the deep-link effect a real target node.
//
// scrollIntoViewSpy: the deep-link effect no longer calls native
// scrollIntoView (it drives the timeline container's scrollTop directly to
// avoid scrolling ancestor overflow:hidden boxes — see issue-detail.tsx). We
// keep a no-op stub on the prototype so any stray scrollIntoView call from
// other components doesn't throw; deep-link tests assert the highlight
// background instead, which is mechanism-independent and observable without
// layout.
const scrollIntoViewSpy = vi.hoisted(() => vi.fn());
const scrollToIndexSpy = vi.hoisted(() => vi.fn());

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    { data, itemContent, computeItemKey }: {
      data: unknown[];
      itemContent: (i: number, item: unknown) => unknown;
      computeItemKey: (i: number, item: unknown) => React.Key;
    },
    ref: any,
  ) {
    useImperativeHandle(ref, () => ({
      // Real Virtuoso ref methods are not exercised by tests in this file
      // since the deep-link cold-path drives the container's scrollTop on the
      // real DOM node, not Virtuoso's imperative API.
      scrollIntoView: vi.fn(),
      scrollToIndex: scrollToIndexSpy,
    }));
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, i) => (
          <div key={computeItemKey(i, item)}>{itemContent(i, item) as React.ReactElement}</div>
        ))}
      </div>
    );
  }),
}));

// jsdom's HTMLElement.prototype.scrollIntoView is a no-op stub; replace it
// with a spy so the deep-link effect's call can be observed.
beforeEach(() => {
  scrollIntoViewSpy.mockClear();
  scrollToIndexSpy.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoViewSpy,
  });
  // The resolved-expand store is module-global (not per-mount like the old
  // useState); reset so one test's expansions can't leak into the next.
  useResolvedExpandStore.setState({ expandedByIssue: {} });
  useCommentCollapseStore.setState({ collapsedByIssue: {} });
});

// Mock modals
const mockOpenModal = vi.hoisted(() => vi.fn());
vi.mock("@multica/core/modals", () => ({
  useModalStore: Object.assign(
    (selector?: (state: { open: typeof mockOpenModal }) => unknown) => {
      const state = { open: mockOpenModal };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ open: mockOpenModal }) },
  ),
}));

// Mock core/hooks/use-file-upload
vi.mock("@multica/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadWithToast: vi.fn().mockResolvedValue("https://example.com/file.png") }),
}));

// Mock realtime
vi.mock("@multica/core/realtime", () => ({
  useWSEvent: vi.fn(),
  useWSReconnect: vi.fn(),
  useWS: () => ({ subscribe: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }),
  WSProvider: ({ children }: { children: React.ReactNode }) => children,
  useRealtimeSync: () => {},
}));

// Mock sonner
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock react-resizable-panels (used by @multica/ui/components/ui/resizable)
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => <div data-testid="panel-group" {...props}>{children}</div>,
  Panel: ({ children, ...props }: any) => <div data-testid="panel" {...props}>{children}</div>,
  Separator: ({ children, ...props }: any) => <div data-testid="panel-handle" {...props}>{children}</div>,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
  usePanelRef: () => ({ current: { isCollapsed: () => false, expand: vi.fn(), collapse: vi.fn() } }),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockIssue: Issue = {
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

const mockTimeline: TimelineEntry[] = [
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

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------

import { IssueDetail } from "./issue-detail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

const highlightedCommentBackgroundClass =
  "bg-[color-mix(in_srgb,var(--card)_95%,var(--brand)_5%)]";

function hasHighlightedCommentBackground(root: ParentNode | null): boolean {
  if (!root) return false;

  const elements = root instanceof Element
    ? [root, ...Array.from(root.querySelectorAll("[class]"))]
    : Array.from(root.querySelectorAll("[class]"));

  return elements.some(
    (el) => typeof el.className === "string" && el.className.includes(highlightedCommentBackgroundClass),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OL-270 — web-timing fixture, modeled on measured Next 16.3.4 / React 19.2.3
// behavior (credit: review repro attachment), updated to the FIXED platform
// contract this PR ships:
//   - a push/replace renders the new route while window.location still holds
//     the PREVIOUS URL; Next writes history in HistoryUpdater's
//     useInsertionEffect, i.e. during commit;
//   - the adapter records the navigation target and reports ITS fragment while
//     the URL hasn't committed yet (apps/web/platform/navigation.tsx);
//   - the page remounts when the [id] segment changes (measured: mountId
//     changed on every cross-issue push);
//   - view-state memento keyed by the pathname React is rendering, verbatim
//     semantics of the fixed apps/web/platform/scroll-restoration.tsx;
//   - a push carrying `#comment-…` clears the destination route's landed
//     memento (fresh intent), also mirroring navigation.tsx.
// The `lateHash` flavor models hydration: getServerSnapshot() is "" on the
// first committed render and the real fragment arrives one commit later.
// ---------------------------------------------------------------------------
import { startTransition, useInsertionEffect, useMemo, useSyncExternalStore } from "react";
import { NavigationProvider } from "../../navigation";
import { ScrollRestorationProvider, type ScrollRestorationAdapter } from "../../platform";
import { IssueDetailRoute, parseCommentHighlightHash } from "./issue-detail-route";
import { ISSUE_HIGHLIGHT_MEMENTO_PREFIX } from "./issue-detail";

const savedViewState = new Map<string, string>();
const savedOffsets = new Map<string, { top: number; height: number }>();
const mementoKey = (pathname: string, key: string) => `${pathname}::${key}`;

function splitInAppPath(path: string): { pathname: string; hash: string } {
  const hashIdx = path.indexOf("#");
  const hash = hashIdx === -1 ? "" : path.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? path : path.slice(0, hashIdx);
  const queryIdx = beforeHash.indexOf("?");
  return {
    pathname: queryIdx === -1 ? beforeHash : beforeHash.slice(0, queryIdx),
    hash,
  };
}

function subscribeToHash(onStoreChange: () => void) {
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

type RouterState = { href: string; mode: "push" | "replace" };
const routerApi: { push: (h: string) => void; replace: (h: string) => void } = {
  push: () => {},
  replace: () => {},
};
const replaceCalls: string[] = [];

function HistoryUpdater({ state }: { state: RouterState }) {
  useInsertionEffect(() => {
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (state.mode === "push" && current !== state.href) window.history.pushState({}, "", state.href);
    else window.history.replaceState({}, "", state.href);
  }, [state]);
  return null;
}

let useMemento = true;
function WebShell({ initialHref, lateHash = false }: { initialHref: string; lateHash?: boolean }) {
  const [state, setState] = useState<RouterState>({ href: initialHref, mode: "replace" });
  // Mirrors pendingNavRef in apps/web/platform/navigation.tsx: the adapter
  // records the navigation target and reports its fragment while
  // window.location hasn't committed yet.
  const pendingNavRef = useRef<{ pathname: string; hash: string } | null>(null);
  routerApi.push = (href) => {
    const target = splitInAppPath(href);
    pendingNavRef.current = target;
    // Fresh deep-link intent clears the destination route's landed record —
    // mirrors the clear in the web adapter's push.
    if (parseCommentHighlightHash(target.hash)) {
      const prefix = mementoKey(target.pathname, ISSUE_HIGHLIGHT_MEMENTO_PREFIX);
      for (const key of [...savedViewState.keys()]) {
        if (key.startsWith(prefix)) savedViewState.delete(key);
      }
    }
    startTransition(() => setState({ href, mode: "push" }));
  };
  routerApi.replace = (href) => {
    replaceCalls.push(href);
    pendingNavRef.current = splitInAppPath(href);
    startTransition(() => setState({ href, mode: "replace" }));
  };
  const pathname = splitInAppPath(state.href).pathname;
  // The memento keys by the pathname React is rendering, not the uncommitted
  // window.location.pathname — mirrors the fixed web scroll-restoration.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const rawHash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => "");
  // Hydration flavor: the server snapshot is "" on the first committed render.
  const [hydrated, setHydrated] = useState(!lateHash);
  useEffect(() => {
    if (!hydrated) setHydrated(true);
  }, [hydrated]);
  const committedHash = hydrated ? rawHash : "";
  const pending = pendingNavRef.current;
  const hash =
    pending &&
    pending.pathname === pathname &&
    window.location.pathname + window.location.hash !== pending.pathname + pending.hash
      ? pending.hash
      : committedHash;
  useEffect(() => {
    const recorded = pendingNavRef.current;
    if (
      recorded &&
      window.location.pathname + window.location.hash === recorded.pathname + recorded.hash
    ) {
      pendingNavRef.current = null;
    }
  }, [pathname, rawHash]);

  const webMemento = useMemo<ScrollRestorationAdapter>(
    () => ({
      get(containerKey) {
        return savedOffsets.get(mementoKey(pathnameRef.current, containerKey));
      },
      getViewState(entryKey) {
        return savedViewState.get(mementoKey(pathnameRef.current, entryKey));
      },
      setViewState(entryKey, value) {
        const key = mementoKey(pathnameRef.current, entryKey);
        if (value === undefined) savedViewState.delete(key);
        else savedViewState.set(key, value);
      },
    }),
    [],
  );

  const adapter = {
    push: routerApi.push,
    replace: routerApi.replace,
    back: () => {},
    pathname,
    searchParams: new URLSearchParams(),
    hash,
    getShareableUrl: (p: string) => p,
  };
  const routeId = pathname.split("/").pop()!;
  return (
    <>
      <HistoryUpdater state={state} />
      <NavigationProvider value={adapter}>
        {useMemento ? (
          <ScrollRestorationProvider adapter={webMemento}>
            <IssueDetailRoute key={routeId} routeId={routeId} />
          </ScrollRestorationProvider>
        ) : (
          <IssueDetailRoute key={routeId} routeId={routeId} />
        )}
      </NavigationProvider>
    </>
  );
}

const P_UUID = "7a4f4b62-9b0f-4e3a-9d3c-5f1d0f2a9b11";
const parentIssue: Issue = { ...mockIssue, id: P_UUID, identifier: "TES-2", title: "Parent issue" };
const parentTimeline: TimelineEntry[] = [
  ...mockTimeline.map((e) => ({ ...e, id: `p-${e.id}` })),
  { ...mockTimeline[0]!, id: "b", content: "Source comment in the parent", created_at: "2026-01-18T00:00:00Z", updated_at: "2026-01-18T00:00:00Z" },
];

function appQueryClient() {
  // packages/core/query-client.ts: staleTime Infinity, gcTime 10 min.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 10 * 60 * 1000 }, mutations: { retry: false } },
  });
}

function renderShell(qc: QueryClient, initialHref: string, lateHash = false) {
  window.history.replaceState({}, "", initialHref);
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        <WebShell initialHref={initialHref} lateHash={lateHash} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const url = () => window.location.pathname + window.location.hash;
const landed = () => hasHighlightedCommentBackground(document.getElementById("comment-b"));

const detailTree = (qc: QueryClient, highlight?: string, issueId = "issue-1", adapter?: ScrollRestorationAdapter) => {
  const detail = <IssueDetail issueId={issueId} highlightCommentId={highlight} />;
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <QueryClientProvider client={qc}>
        {adapter ? <ScrollRestorationProvider adapter={adapter}>{detail}</ScrollRestorationProvider> : detail}
      </QueryClientProvider>
    </I18nProvider>
  );
};

function resetApiMocks() {
  vi.clearAllMocks();
  savedViewState.clear();
  savedOffsets.clear();
  replaceCalls.length = 0;
  mockViewport.isMobile = false;
  window.history.replaceState({}, "", "/test/issues/TES-1");
  mockApiObj.getIssue.mockImplementation((id: string) =>
    Promise.resolve(id === P_UUID || id === "TES-2" ? parentIssue : mockIssue),
  );
  mockApiObj.listTimeline.mockImplementation((issueId: string) =>
    Promise.resolve(issueId === P_UUID ? parentTimeline : mockTimeline),
  );
  mockApiObj.listIssueReactions.mockResolvedValue([]);
  mockApiObj.listIssueSubscribers.mockResolvedValue([]);
  mockApiObj.listChildIssues.mockResolvedValue({ issues: [] });
  mockApiObj.getChildIssueProgress.mockResolvedValue({ progress: [] });
  mockApiObj.getAgentTaskSnapshot.mockResolvedValue([]);
  mockApiObj.getWorkspaceWorkingAgents.mockResolvedValue([]);
  mockApiObj.listProperties.mockResolvedValue({ properties: [], total: 0 });
  mockApiObj.listIssues.mockResolvedValue({ issues: [], total: 0 });
  mockApiObj.getActiveTasksForIssue.mockResolvedValue({ tasks: [] });
  mockApiObj.listTasksByIssue.mockResolvedValue([]);
  mockApiObj.listTaskMessages.mockResolvedValue([]);
  mockApiObj.listMembers.mockResolvedValue([
    { user_id: "user-1", name: "Test User", email: "test@test.com", role: "admin" },
  ]);
  mockApiObj.listAgents.mockResolvedValue([]);
  mockApiObj.getProject.mockReset();
}

async function startOnSubtask(qc: QueryClient) {
  renderShell(qc, "/test/issues/TES-1");
  await waitFor(() => expect(screen.getAllByText("Implement authentication").length).toBeGreaterThan(0));
}

async function settleOnParent() {
  await waitFor(() => expect(url()).toBe("/test/issues/TES-2#comment-b"));
  await waitFor(() => expect(document.getElementById("comment-b")).not.toBeNull());
}

async function expectLanded() {
  await waitFor(() => expect(landed()).toBe(true), { timeout: 1500 });
}

const seedParent = (qc: QueryClient) => {
  qc.setQueryData(issueKeys.detail("ws-1", "TES-2"), parentIssue);
  qc.setQueryData(issueKeys.detail("ws-1", P_UUID), parentIssue);
  qc.setQueryData(issueKeys.timeline(P_UUID), parentTimeline);
};

describe("OL-270 AC1/AC2 — source jump and comment links under web timing", () => {
  beforeEach(resetApiMocks);

  it("AC1 跳转到来源评论（UUID 地址 + canonical 改写），父任务已缓存", async () => {
    const qc = appQueryClient();
    qc.setQueryData(issueKeys.detail("ws-1", P_UUID), parentIssue);
    qc.setQueryData(issueKeys.timeline(P_UUID), parentTimeline);
    await startOnSubtask(qc);
    await act(async () => routerApi.push(`/test/issues/${P_UUID}#comment-b`));
    await settleOnParent();
    await expectLanded();
  });

  it("AC1 跳转到来源评论（UUID 地址 + canonical 改写），父任务未缓存", async () => {
    const qc = appQueryClient();
    await startOnSubtask(qc);
    await act(async () => routerApi.push(`/test/issues/${P_UUID}#comment-b`));
    await settleOnParent();
    await expectLanded();
  });

  it("AC2 标识符链接首次点击（目标已缓存）落点并高亮", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    await startOnSubtask(qc);
    await act(async () => routerApi.push("/test/issues/TES-2#comment-b"));
    await settleOnParent();
    await expectLanded();
  });

  it("AC2 离开后再次点击同一条评论链接仍落点（push 清掉已落点记录）", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    await startOnSubtask(qc);
    await act(async () => routerApi.push("/test/issues/TES-2#comment-b"));
    await settleOnParent();
    await expectLanded(); // first click lands
    await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
    await act(async () => routerApi.push("/test/issues/TES-1"));
    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await waitFor(() => expect(screen.getAllByText("Implement authentication").length).toBeGreaterThan(0));
    await act(async () => routerApi.push("/test/issues/TES-2#comment-b"));
    await settleOnParent();
    await expectLanded(); // second click lands again
  }, 15000);

  it("AC5 从带 #comment 的页面跳到无 hash 的任务：不沿用旧 hash、不拍平", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    await startOnSubtask(qc);
    await act(async () => routerApi.push("/test/issues/TES-2#comment-b"));
    await settleOnParent();
    await expectLanded();

    await act(async () => routerApi.push("/test/issues/TES-1"));

    await waitFor(() => expect(url()).toBe("/test/issues/TES-1"));
    await waitFor(() => expect(document.getElementById("comment-comment-1")).not.toBeNull());
    // The sub-task's own timeline must be virtualized (no stale-hash flatten):
    expect(screen.getByTestId("virtuoso-mock")).toBeInTheDocument();
    // …and nothing on it is highlighted.
    expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-1"))).toBe(false);
    expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-2"))).toBe(false);
  });

  it("整页打开标识符地址（水合晚一帧），数据未缓存：到达落点", async () => {
    const qc = appQueryClient();
    renderShell(qc, "/test/issues/TES-2#comment-b", true);
    await settleOnParent();
    await expectLanded();
  });

  it("整页打开（水合晚一帧）且数据全缓存：经 Virtuoso 落点，不拍平", async () => {
    const qc = appQueryClient();
    seedParent(qc);
    renderShell(qc, "/test/issues/TES-2#comment-b", true);
    await settleOnParent();
    await expectLanded();
    expect(screen.getByTestId("virtuoso-mock")).toBeInTheDocument();
  });
});

describe("OL-270 detail-level races", () => {
  beforeEach(resetApiMocks);

  it("highlight 晚到 + 时间线先于 issue 返回：落点不被吞（着陆而非 scrollToIndex 空跑）", async () => {
    // The review repro asserted the mechanism (scrollToIndex). The fixed
    // arrival capture happens on the first READY frame, so this race now
    // resolves through the flat arrival landing — assert the user-visible
    // outcome instead: the target comment ends up highlighted.
    const issueResolvers: Array<(v: Issue) => void> = [];
    mockApiObj.getIssue.mockImplementation(() => new Promise<Issue>((r) => { issueResolvers.push(r); }));
    const qc = createTestQueryClient();
    const { rerender } = render(detailTree(qc));
    rerender(detailTree(qc, "comment-2"));
    await waitFor(() => expect(mockApiObj.listTimeline).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await act(async () => { issueResolvers.splice(0).forEach((r) => r(mockIssue)); mockApiObj.getIssue.mockResolvedValue(mockIssue); });
    await waitFor(() => expect(document.getElementById("comment-comment-2")).not.toBeNull());
    await waitFor(() => expect(
      hasHighlightedCommentBackground(document.getElementById("comment-comment-2")),
    ).toBe(true));
  });

  it("AC5 旧页面残留的 hash（目标不在本 issue 的 items 里）不拍平时间线", async () => {
    const qc = createTestQueryClient();
    qc.setQueryData(issueKeys.timeline("issue-1"), mockTimeline);
    render(detailTree(qc, "comment-from-previous-page"));
    await waitFor(() => expect(screen.getAllByText("Implement authentication").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("virtuoso-mock")).toBeInTheDocument();
  });

  it("D3 以 #comment-x 到达后同页跳到 y、再回到 x（如浏览器后退），不再拍平时间线", async () => {
    mockApiObj.getIssue.mockResolvedValue(mockIssue);
    mockApiObj.listTimeline.mockResolvedValue(mockTimeline);
    const qc = createTestQueryClient();
    const { rerender } = render(detailTree(qc, "comment-1"));
    await waitFor(() => expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-1"))).toBe(true));
    expect(screen.queryByTestId("virtuoso-mock")).toBeNull();
    rerender(detailTree(qc, "comment-2"));
    await waitFor(() => expect(screen.getByTestId("virtuoso-mock")).toBeInTheDocument());
    rerender(detailTree(qc, "comment-1"));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(screen.queryByTestId("virtuoso-mock")).toBeInTheDocument();
  });

  it("D1 桌面端：旧 issue 先以新 #comment 提交一帧、再切到新 issue，仍要落点", async () => {
    const issue2: Issue = { ...mockIssue, id: "issue-2", identifier: "TES-3", title: "Second issue" };
    const timeline2: TimelineEntry[] = [{ ...mockTimeline[0]!, id: "comment-b2", content: "Target in the second issue" }];
    mockApiObj.getIssue.mockImplementation((id: string) => Promise.resolve(id === "issue-2" ? issue2 : mockIssue));
    mockApiObj.listTimeline.mockImplementation((issueId: string) => Promise.resolve(issueId === "issue-2" ? timeline2 : mockTimeline));
    const qc = createTestQueryClient();
    const { rerender } = render(detailTree(qc));
    await waitFor(() => expect(document.getElementById("comment-comment-1")).not.toBeNull());
    rerender(detailTree(qc, "comment-b2", "issue-1"));
    rerender(detailTree(qc, "comment-b2", "issue-2"));
    await waitFor(() => expect(document.getElementById("comment-comment-b2")).not.toBeNull());
    await waitFor(() => expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-b2"))).toBe(true));
  });

  it("D2 同页跳转后切回标签页（重挂载恢复视图）不再跳一次", async () => {
    const view = new Map<string, string>();
    const adapter: ScrollRestorationAdapter = {
      get: () => undefined,
      getViewState: (k) => view.get(k),
      setViewState: (k, v) => { if (v === undefined) view.delete(k); else view.set(k, v); },
    };
    const qc = createTestQueryClient();
    const first = render(detailTree(qc, undefined, "issue-1", adapter));
    await waitFor(() => expect(document.getElementById("comment-comment-1")).not.toBeNull());
    first.rerender(detailTree(qc, "comment-2", "issue-1", adapter));
    await waitFor(() => expect(scrollToIndexSpy).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 2600)); });
    first.unmount();
    render(detailTree(qc, "comment-2", "issue-1", adapter));
    await waitFor(() => expect(document.getElementById("comment-comment-2")).not.toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(hasHighlightedCommentBackground(document.getElementById("comment-comment-2"))).toBe(false);
  }, 10000);

  it("对照：无 memento provider 时来源跳转落点（C1）", async () => {
    useMemento = false;
    try {
      const qc = appQueryClient();
      qc.setQueryData(issueKeys.detail("ws-1", P_UUID), parentIssue);
      qc.setQueryData(issueKeys.timeline(P_UUID), parentTimeline);
      await startOnSubtask(qc);
      await act(async () => routerApi.push(`/test/issues/${P_UUID}#comment-b`));
      await settleOnParent();
      await expectLanded();
    } finally {
      useMemento = true;
    }
  });
});
