// Both chat surfaces — the full page and the floating window — mount the same
// ChatReplyActionsProvider around their conversation. These tests drive a real
// HTML block card inside each REAL surface, through its REAL handleSend, into
// a server stub that mirrors the send-dedup contract (session + client_message
// id, replayed within the cache window — server/internal/handler/chat.go and
// chat_send_cache.go): a response lost AFTER the server persisted the send must
// not duplicate the message or its task when the card is retried unchanged.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type {
  Agent,
  ChatMessage,
  ChatPendingTask,
  ChatSession,
} from "@multica/core/types";
import enCommon from "../locales/en/common.json";
import enChat from "../locales/en/chat.json";
import enEditor from "../locales/en/editor.json";
import { mockNativeDialog } from "../editor/test-utils/native-dialog";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "../navigation";

vi.mock("../editor/code-block-static", () => ({
  CodeBlockStatic: ({ body }: { body: string }) => (
    <pre data-testid="code-block-static">{body}</pre>
  ),
}));

// --- The server: records sends keyed by clientMessageId, replays on dedup ----
const server = vi.hoisted(() => {
  let seq = 0;
  const sent: { clientMessageId: string; messageId: string; taskId: string; content: string }[] = [];
  let loseNext = false;
  return {
    sent,
    /** The response for the NEXT new send is lost after the server persisted it. */
    loseResponseOnce() { loseNext = true; },
    reset() {
      seq = 0;
      sent.length = 0;
      loseNext = false;
    },
    send: vi.fn(async (_sessionId: string, content: string, _atts: unknown, clientMessageId: string) => {
      const existing = sent.find((m) => m.clientMessageId === clientMessageId);
      if (existing) {
        // Dedup window hit: replay the first result, no second message/task.
        return {
          message_id: existing.messageId,
          task_id: existing.taskId,
          created_at: "2026-11-09T00:00:00Z",
          supports_queue: false,
          queued: false,
          attachment_ids: [],
        };
      }
      seq += 1;
      const row = { clientMessageId, messageId: `msg-${seq}`, taskId: `task-${seq}`, content };
      sent.push(row);
      const accepted = {
        message_id: row.messageId,
        task_id: row.taskId,
        created_at: "2026-11-09T00:00:00Z",
        supports_queue: false,
        queued: false,
        attachment_ids: [],
      };
      if (loseNext) {
        loseNext = false;
        throw new Error("response lost after the server persisted the send");
      }
      return accepted;
    }),
  };
});

// --- Fixtures the mocked queries return --------------------------------------
const h = vi.hoisted(() => ({
  agents: [] as Agent[],
  sessions: [] as ChatSession[],
  messages: [] as ChatMessage[],
  pendingTask: null as ChatPendingTask | null,
}));

// In-memory query cache so seedAcceptedPendingTask / hasInFlightPendingTask
// (the just-created-session exemption of the self-heal) behave like the real one.
const queryCache = vi.hoisted(() => {
  const cache = new Map<string, unknown>();
  return {
    clear: () => cache.clear(),
    client: {
      getQueryData: vi.fn((key: unknown[]) => cache.get(JSON.stringify(key))),
      setQueryData: vi.fn((key: unknown[], valueOrUpdater: unknown) => {
        const k = JSON.stringify(key);
        const old = cache.get(k);
        const next =
          typeof valueOrUpdater === "function"
            ? (valueOrUpdater as (current: unknown) => unknown)(old)
            : valueOrUpdater;
        if (next === undefined) cache.delete(k);
        else cache.set(k, next);
      }),
      invalidateQueries: vi.fn(),
      cancelQueries: vi.fn(),
    },
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: { queryKey?: unknown[] }) => {
      const key = options.queryKey ?? [];
      if (key.includes("agents")) return { data: h.agents };
      if (key.includes("members")) return { data: [{ user_id: "user-1", role: "admin" }] };
      if (key.includes("sessions")) return { data: h.sessions, isSuccess: true };
      if (key.includes("projects")) return { data: [], isSuccess: true };
      if (key.includes("pending-task")) return { data: h.pendingTask };
      return { data: null };
    },
    useInfiniteQuery: () => ({
      data: { pages: [{ messages: h.messages }] },
      isLoading: false,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    }),
    useQueryClient: () => queryCache.client,
  };
});

// Reactive-enough chat store: surfaces read it per render; writes notify the
// URL-sync subscribers through the same listener set.
vi.mock("@multica/core/chat", () => {
  const listeners = new Set<() => void>();
  const state = {
    isOpen: true,
    isExpanded: false,
    activeSessionId: null as string | null,
    selectedAgentId: null as string | null,
    selectedProjectId: null as string | null,
    inputDrafts: {} as Record<string, string>,
    inputDraftAttachments: {} as Record<string, unknown[]>,
  };
  const commit = (patch: Record<string, unknown>) => {
    Object.assign(state, patch);
    listeners.forEach((l) => l());
  };
  // Actions live IN the state, like the real zustand store: components select
  // them with useChatStore((s) => s.setActiveSession).
  const actions = {
    setOpen: (open: boolean) => commit({ isOpen: open }),
    setActiveSession: (id: string | null) => commit({ activeSessionId: id }),
    setSelectedAgentId: (id: string | null) => commit({ selectedAgentId: id }),
    setSelectedProjectId: (id: string | null) => commit({ selectedProjectId: id }),
    setInputDraft: (key: string, draft: string) =>
      commit({ inputDrafts: { ...state.inputDrafts, [key]: draft } }),
  };
  Object.assign(state, actions);
  return {
    DRAFT_NEW_SESSION: "__draft_new__",
    useChatStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      {
        getState: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ...actions,
      },
    ),
  };
});

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/platform", () => ({
  getCurrentWsId: () => "ws-1",
  getCurrentSlug: () => "acme",
}));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) =>
    sel({ user: { id: "user-1" } }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  agentListOptions: () => ({ queryKey: ["agents"] }),
  memberListOptions: () => ({ queryKey: ["members"] }),
}));
vi.mock("@multica/core/projects/queries", () => ({
  projectListOptions: () => ({ queryKey: ["projects"] }),
}));
vi.mock("../issues/components/pickers/assignee-picker", () => ({
  canAssignAgent: () => true,
}));
vi.mock("@multica/core/api", () => ({
  api: {
    sendChatMessage: server.send,
    cancelTaskById: vi.fn(),
    clearQueuedChatTasks: vi.fn(),
    prioritizeQueuedChatTask: vi.fn(),
    updateChatSession: vi.fn(),
  },
  dispatchReasonCode: () => undefined,
}));
vi.mock("@multica/core/agents", () => ({
  isAgentRuntimeBound: () => true,
  useAgentPresenceDetail: () => ({ availability: "online" }),
  useCustomizeConversationStartersHref: () => null,
  useWorkspaceAgentAvailability: () => "available",
}));
vi.mock("@multica/core/chat/queries", () => ({
  chatKeys: {
    messages: (id: string) => ["chat", "messages", id],
    messagesPage: (id: string) => ["chat", "messages-page", id],
    pendingTask: (id: string) => ["chat", "pending-task", id],
    quickActionsPending: (id: string) => ["chat", "quick-actions-pending", id],
    quickActionsFailure: (id: string) => ["chat", "quick-actions-failure", id],
  },
  isTaskMessageTaskId: (taskId: string) => !taskId.startsWith("local:"),
  sortChatSessions: (sessions: ChatSession[]) => [...sessions],
  chatQuickActionsFailureOptions: () => ({ queryKey: ["chat", "quick-actions-failure"] }),
  chatSessionsOptions: () => ({ queryKey: ["chat", "sessions"] }),
  chatMessagesPageOptions: () => ({ queryKey: ["chat", "messages-page"] }),
  pendingChatTaskOptions: () => ({ queryKey: ["chat", "pending-task"] }),
  pendingChatTasksOptions: () => ({ queryKey: ["chat", "pending-tasks"] }),
  taskMessagesOptions: () => ({ queryKey: ["chat", "task-messages"] }),
  chatQuickActionsPendingOptions: () => ({ queryKey: ["chat", "quick-actions-pending"] }),
}));
vi.mock("@multica/core/chat/mutations", () => ({
  useCreateChatSession: () => ({ mutateAsync: vi.fn(async () => ({ id: "new-session" })) }),
  useMarkChatSessionRead: () => ({ mutate: vi.fn() }),
  useSetChatSessionArchived: () => ({ mutate: vi.fn() }),
  useSetChatSessionProject: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateChatSession: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
  useConsumeChatDraftRestore: () => ({ mutate: vi.fn() }),
  useRegenerateChatQuickActions: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@multica/core/realtime", () => ({
  removeChatMessageFromCaches: vi.fn(),
}));
vi.mock("@multica/core/logger", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multica/core/logger")>(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@multica/core/you-should-know", () => ({
  useTipSideChatLookup: () => ({ currentSession: null, pinsAgent: false, pending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// --- Conversation internals: the card replaces the message list, the rest is
// stubbed so the surfaces under test stay ChatPage and ChatWindow themselves. --
vi.mock("./components/chat-message-list", () => ({
  // One assistant message renders this list (see h.messages), carrying a card.
  ChatMessageList: () => <CardSurface />,
  ChatMessageSkeleton: () => null,
}));
vi.mock("./components/chat-window-messages", () => ({
  ChatWindowMessages: ({ children }: { children: React.ReactNode }) => (
    <div>
      {children}
      <CardSurface />
    </div>
  ),
}));
vi.mock("./components/chat-input", () => ({ ChatInput: () => <div>chat-input</div> }));
vi.mock("./components/chat-queue", () => ({ ChatQueue: () => null }));
vi.mock("./components/chat-empty-state", () => ({ EmptyState: () => null }));
vi.mock("./components/chat-session-header", () => ({ ChatSessionHeader: () => null }));
vi.mock("./components/chat-thread-list", () => ({
  ChatThreadList: () => <div>chat-thread-list</div>,
}));
vi.mock("./components/new-chat-button", () => ({ NewChatButton: () => null }));
vi.mock("./components/offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("./components/no-agent-banner", () => ({ NoAgentBanner: () => null }));
vi.mock("./components/archived-agent-banner", () => ({ ArchivedAgentBanner: () => null }));
vi.mock("./components/agent-access-revoked-banner", () => ({ AgentAccessRevokedBanner: () => null }));
vi.mock("./components/runtime-required-banner", () => ({ RuntimeRequiredBanner: () => null }));
vi.mock("./components/chat-resize-handles", () => ({ ChatResizeHandles: () => null }));
vi.mock("./components/session-rename-input", () => ({ SessionRenameInput: () => null }));
vi.mock("./components/session-history-list", () => ({ SessionHistoryList: () => null }));
vi.mock("./components/use-chat-draft-restore", () => ({
  useChatDraftRestore: () => ({
    restoreDraftRequest: null,
    enqueueLocalRestore: vi.fn(),
    handleRestoreDraftApplied: vi.fn(),
  }),
}));
vi.mock("./components/use-chat-task-actions", () => ({
  useChatTaskActions: () => ({
    cancelChatTask: vi.fn(async () => {}),
    handleEditQueuedTask: vi.fn(),
    handleRemoveQueuedTask: vi.fn(),
    handleClearQueuedTasks: vi.fn(),
    handleSendQueuedTaskNow: vi.fn(),
  }),
}));
vi.mock("./components/use-chat-project-context-support", () => ({
  useChatProjectContextSupport: () => true,
}));
vi.mock("./components/use-chat-context-items", () => ({
  useChatContextItems: () => null,
}));
vi.mock("./components/use-chat-resize", () => ({
  useChatResize: () => ({
    renderWidth: 400,
    renderHeight: 500,
    isAtMax: false,
    boundsReady: true,
    isDragging: false,
    toggleExpand: vi.fn(),
    startDrag: vi.fn(),
  }),
}));
vi.mock("./components/use-visual-viewport-keyboard", () => ({
  useVisualViewportKeyboard: () => null,
}));
vi.mock("./components/use-chat-open-reveal", () => ({
  useChatOpenReveal: () => ({ contentReady: true, markContentReady: vi.fn() }),
}));
vi.mock("../you-should-know/side-chat/tip-side-chat-banner", () => ({
  TipSideChatBanner: () => null,
}));
vi.mock("../you-should-know/side-chat/tip-side-chat-starters", () => ({
  TipSideChatStarters: () => null,
}));
vi.mock("../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../common/deferred-tooltip", () => ({
  DeferredTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../common/shortcut-keycaps", () => ({ ActionShortcutKeycaps: () => null }));
vi.mock("../common/row-actions-menu", () => ({
  RowActionsMenu: () => null,
  handleRowActivationKey: () => undefined,
}));
vi.mock("../issues/components/pickers/property-picker", () => ({
  PickerEmpty: () => null,
  PickerItem: () => null,
  PickerSection: () => null,
  PropertyPicker: () => null,
}));
vi.mock("@multica/ui/hooks/use-mobile", () => ({
  useIsMobile: () => false,
  useIsCompact: () => false,
}));
vi.mock("@multica/core/paths", () => ({
  useRequiredWorkspaceSlug: () => "acme",
  useWorkspacePaths: () => ({ chat: () => "/acme/chat" }),
}));

import { ChatPage } from "./chat-page";
import { ChatWindow } from "./components/chat-window";
import { HtmlBlockPreview } from "../editor/html-block-preview";
import { HTML_BLOCK_MESSAGE_KEY } from "../editor/utils/html-block-document";
import { useChatStore } from "@multica/core/chat";

const TEST_RESOURCES = { en: { common: enCommon, chat: enChat, editor: enEditor } };
const CARD_HTML = "<p>decision</p>";

const agent: Agent = {
  id: "agent-1",
  workspace_id: "ws-1",
  runtime_id: "runtime-1",
  name: "Lambda",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "local",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  permission_mode: "public_to",
  invocation_targets: [{ target_type: "workspace", target_id: null }],
  status: "idle",
  max_concurrent_tasks: 1,
  model: "",
  owner_id: "user-2",
  skills: [],
  created_at: "2026-05-28T00:00:00Z",
  updated_at: "2026-05-28T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

/** The decision card both message-area mocks render inside the surface. */
function CardSurface() {
  return <HtmlBlockPreview html={CARD_HTML} />;
}

function inlineFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>('[data-dynamic-block="html"] iframe');
  expect(frame).not.toBeNull();
  return frame!;
}

function post(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { [HTML_BLOCK_MESSAGE_KEY]: 1, ...data },
        source: frame.contentWindow,
      }),
    );
  });
}

const result = (action: string, ok: boolean) => ({
  __multicaHtmlBlock: 1,
  type: "action-result",
  action,
  ok,
});

/** Submit from the (possibly re-mounted) card and resolve once it is acked. */
async function submitFromCard(content: string, ok: boolean) {
  const frame = inlineFrame();
  const reply = vi.spyOn(frame.contentWindow!, "postMessage");
  post(frame, { type: "submit-comment", content });
  await waitFor(() => expect(reply).toHaveBeenCalledWith(result("submit-comment", ok), "*"));
}

type SurfaceStoreState = {
  isOpen: boolean;
  isExpanded: boolean;
  activeSessionId: string | null;
  selectedAgentId: string | null;
  selectedProjectId: string | null;
  inputDrafts: Record<string, string>;
  inputDraftAttachments: Record<string, unknown[]>;
};

function resetStore(patch: Record<string, unknown> = {}) {
  const state = useChatStore.getState() as unknown as SurfaceStoreState;
  Object.assign(state, {
    isOpen: true,
    isExpanded: false,
    activeSessionId: null,
    selectedAgentId: null,
    selectedProjectId: null,
    inputDrafts: {},
    inputDraftAttachments: {},
    ...patch,
  });
}

let restoreDialog: () => void;
let restoreActivation: () => void;
beforeEach(() => {
  window.sessionStorage.clear();
  restoreDialog = mockNativeDialog();
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive: true },
  });
  restoreActivation = () => delete (navigator as { userActivation?: unknown }).userActivation;
  server.reset();
  queryCache.clear();
  server.send.mockClear();
  h.agents = [agent];
  h.sessions = [];
  h.pendingTask = null;
  h.messages = [
    {
      id: "msg-card",
      chat_session_id: "s1",
      role: "assistant",
      content: "card host message",
      task_id: null,
      created_at: "2026-11-09T00:00:00Z",
      attachments: [],
    },
  ];
  resetStore();
});
afterEach(() => {
  cleanup();
  restoreDialog();
  restoreActivation();
  vi.restoreAllMocks();
});

/** The retry contract, driven end to end through one surface. */
async function lostResponseRetryScenario() {
  // 1. The server persists the send, then the response is lost.
  server.loseResponseOnce();
  await submitFromCard("拍板：方案 B", false);
  // 2. Unchanged retry: same clientMessageId → the server replays the first
  //    result instead of recording a second message/task.
  await submitFromCard("拍板：方案 B", true);
  expect(server.sent).toHaveLength(1);
  expect(new Set(server.sent.map((m) => m.taskId)).size).toBe(1);
  // 3. A changed answer is a new attempt.
  await submitFromCard("拍板：方案 C", true);
  expect(server.sent).toHaveLength(2);
  // 4. After a success the record is gone: same content is a fresh attempt.
  await submitFromCard("拍板：方案 C", true);
  expect(server.sent).toHaveLength(3);
}

describe("ChatPage (full-page Chat)", () => {
  function renderChatPage() {
    // replace() must keep the adapter's searchParams in sync, or the URL→store
    // effect bounces activeSessionId straight back to the old session.
    const navigation: NavigationAdapter = {
      push: vi.fn(),
      replace: vi.fn((path: string) => {
        const query = path.split("?")[1] ?? "";
        navigation.searchParams = new URLSearchParams(query);
      }),
      back: vi.fn(),
      pathname: "/acme/chat",
      searchParams: new URLSearchParams("session=s1"),
      hash: "",
      getShareableUrl: (path: string) => path,
    };
    return render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <NavigationProvider value={navigation}>
            <ChatPage />
          </NavigationProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it("keeps a lost-response retry to one message and one task", async () => {
    resetStore({ activeSessionId: "s1" });
    renderChatPage();
    await waitFor(() => expect(inlineFrame()).not.toBeNull());
    await lostResponseRetryScenario();
  });

  it("fills the conversation's compose draft from the card", async () => {
    resetStore({ activeSessionId: "s1" });
    renderChatPage();
    const frame = inlineFrame();
    const reply = vi.spyOn(frame.contentWindow!, "postMessage");
    post(frame, { type: "fill-comment", content: "card answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith(result("fill-comment", true), "*"));
  });

  it("rejects the card without user activation", async () => {
    restoreActivation();
    resetStore({ activeSessionId: "s1" });
    renderChatPage();
    const frame = inlineFrame();
    const reply = vi.spyOn(frame.contentWindow!, "postMessage");
    post(frame, { type: "submit-comment", content: "answer" });
    await waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith(result("submit-comment", false), "*"));
    expect(server.send).not.toHaveBeenCalled();
  });
});

describe("ChatWindow (floating window)", () => {
  function renderChatWindow() {
    const navigation: NavigationAdapter = {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      pathname: "/acme/chat",
      searchParams: new URLSearchParams(),
      hash: "",
      getShareableUrl: (path: string) => path,
    };
    return render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <QueryClientProvider client={new QueryClient()}>
          <NavigationProvider value={navigation}>
            <ChatWindow />
          </NavigationProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it("keeps a lost-response retry to one message and one task", async () => {
    renderChatWindow();
    await waitFor(() => expect(inlineFrame()).not.toBeNull());
    await lostResponseRetryScenario();
  });

  it("sends the card as the user in a session and wakes the agent", async () => {
    renderChatWindow();
    await submitFromCard("直接提交", true);
    expect(server.sent).toHaveLength(1);
    const [row] = server.sent;
    expect(row!.taskId).toMatch(/^task-/);
    // The lazy-created session became the active one, as a manual send would.
    expect(useChatStore.getState().activeSessionId).toBe("new-session");
  });
});
