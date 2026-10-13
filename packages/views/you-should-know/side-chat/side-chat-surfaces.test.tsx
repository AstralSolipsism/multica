// @vitest-environment jsdom

/**
 * A YSK side chat on the chat surfaces (OL-362), with the real floating chat
 * window and the real Chat page controller. A side chat is left out of the
 * session list until its first message, so both surfaces must resolve it
 * themselves — with the tip's agent and never a fallback one — and show the
 * tip banner plus the three common questions until a visible message exists.
 * The composer and the message list are stubbed: their own suites cover them.
 */

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatStore, registerChatStore, useChatStore } from "@multica/core/chat";
import { setCurrentWorkspace } from "@multica/core/platform";
import type {
  Agent,
  ChatMessage,
  ChatSession,
  MemberWithUser,
  StorageAdapter,
} from "@multica/core/types";
import { ChatWindow } from "../../chat/components/chat-window";
import { ChatPage } from "../../chat/chat-page";
import { YouShouldKnowArchiveSection } from "../archive/archive-section";
import {
  createNavigation,
  createYskQueryClient,
  makeTip,
  renderWithYsk,
  WS_ID,
  WS_SLUG,
} from "../../test/you-should-know";

const apiMock = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  getChatSession: vi.fn(),
  createChatSession: vi.fn(),
  listChatMessagesPage: vi.fn(),
  getPendingChatTask: vi.fn(),
  listChatDraftRestores: vi.fn(),
  listPendingChatTasks: vi.fn(),
  sendChatMessage: vi.fn(),
  listAgents: vi.fn(),
  listMembers: vi.fn(),
  listProjects: vi.fn(),
  openTipChat: vi.fn(),
  listIssueTips: vi.fn(),
  listActiveTips: vi.fn(),
  setTipState: vi.fn(),
  getNotificationPreferences: vi.fn(),
}));
vi.mock("@multica/core/api", () => ({
  api: apiMock,
  dispatchReasonCode: () => undefined,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));
vi.mock("@multica/core/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/agents")>()),
  useAgentPresenceDetail: () => ({ availability: "online" }),
  useCustomizeConversationStartersHref: () => null,
  useWorkspaceAgentAvailability: () => "available",
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../chat/components/use-chat-context-items", () => ({
  useChatContextItems: () => [],
}));
vi.mock("../../chat/components/use-chat-project-context-support", () => ({
  useChatProjectContextSupport: () => null,
}));
vi.mock("../../chat/components/chat-message-list", () => ({
  ChatMessageList: ({ messages }: { messages: ChatMessage[] }) => (
    <ol data-testid="messages">
      {messages.map((message) => (
        <li key={message.id}>{message.content}</li>
      ))}
    </ol>
  ),
  ChatMessageSkeleton: () => <div data-testid="messages-loading" />,
}));
vi.mock("../../chat/components/chat-input", () => ({
  ChatInput: ({
    agentName,
    disabled,
    leftAdornment,
    onSend,
  }: {
    agentName?: string;
    disabled?: boolean;
    leftAdornment?: React.ReactNode;
    onSend: (content: string) => Promise<boolean>;
  }) => (
    <div
      data-testid="composer"
      data-agent={agentName ?? ""}
      data-disabled={String(!!disabled)}
    >
      {leftAdornment}
      <button type="button" onClick={() => void onSend("hello")}>
        send from composer
      </button>
    </div>
  ),
}));

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    workspace_id: WS_ID,
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
    max_concurrent_tasks: 6,
    model: "",
    owner_id: "user-2",
    skills: [],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    archived_at: null,
    archived_by: null,
    ...overrides,
  } as Agent;
}

const lambda = makeAgent({});
// The member's own preferred agent: the one a fallback would pick.
const sigma = makeAgent({ id: "agent-2", name: "Sigma", owner_id: "user-1" });

const me: MemberWithUser = {
  id: "member-1",
  workspace_id: WS_ID,
  user_id: "user-1",
  role: "member",
  created_at: "2026-10-01T00:00:00Z",
  name: "Ada",
  email: "ada@example.com",
  avatar_url: null,
};

const sideChat: ChatSession = {
  id: "side-1",
  workspace_id: WS_ID,
  agent_id: "agent-1",
  creator_id: "user-1",
  project_id: null,
  title: "OL-1 · Old API kept",
  status: "active",
  has_unread: false,
  created_at: "2026-10-13T00:00:00Z",
  updated_at: "2026-10-13T00:00:00Z",
  tip_source: {
    tip_id: "tip-1",
    issue_id: "issue-1",
    issue_identifier: "OL-1",
    source_task_id: "task-1",
    tip: {
      tag: "heads_up",
      line: "Kept the old API",
      title: "Old API kept",
      explanation: "Clients still call it, so it stays until they move.",
      status: "valid",
      overturned_reason: null,
      overturned_by_comment_id: null,
    },
  },
};

let messages: ChatMessage[];

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  messages = [];
  apiMock.listChatSessions.mockResolvedValue([]);
  apiMock.getChatSession.mockResolvedValue(sideChat);
  apiMock.listChatMessagesPage.mockImplementation(async () => ({
    messages,
    limit: 50,
    has_more: false,
    next_cursor: null,
  }));
  apiMock.getPendingChatTask.mockResolvedValue({});
  apiMock.listChatDraftRestores.mockResolvedValue({ restores: [] });
  apiMock.listPendingChatTasks.mockResolvedValue({ tasks: [] });
  apiMock.listAgents.mockResolvedValue([sigma, lambda]);
  apiMock.listMembers.mockResolvedValue([me]);
  apiMock.listProjects.mockResolvedValue({ projects: [] });
  apiMock.openTipChat.mockResolvedValue(sideChat);
  apiMock.listActiveTips.mockResolvedValue({ tips: [] });
  apiMock.sendChatMessage.mockImplementation(async (sessionId: string, content: string) => {
    messages = [
      {
        id: "message-1",
        chat_session_id: sessionId,
        role: "user",
        content,
        task_id: "11111111-1111-4111-8111-111111111111",
        created_at: "2026-10-13T00:01:00Z",
      },
    ];
    return {
      message_id: "message-1",
      task_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-10-13T00:01:00Z",
      supports_queue: true,
    };
  });

  const values = new Map<string, string>();
  const storage: StorageAdapter = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  registerChatStore(createChatStore({ storage }));
  // The member last chatted with Sigma; a fallback would land there.
  useChatStore.getState().setSelectedAgentId("agent-2");
});

afterEach(() => cleanup());

function composer(): HTMLElement {
  return screen.getByTestId("composer");
}

function banner(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-ysk-side-chat-banner]")!;
}

describe("the floating chat on a side chat", () => {
  it("opens from Ask about this on the tip's own session and agent", async () => {
    apiMock.listIssueTips.mockResolvedValue({ tips: [makeTip({ line: "Kept the old API" })] });
    renderWithYsk(
      <>
        <YouShouldKnowArchiveSection issueId="issue-1" identifier="OL-1" />
        <ChatWindow />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Kept the old API/ }));
    const ask = await screen.findByRole("button", { name: "Ask about this" });
    await waitFor(() => expect(ask).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(ask);

    await waitFor(() => expect(composer()).toHaveAttribute("data-agent", "Lambda"));
    expect(useChatStore.getState()).toMatchObject({ isOpen: true, activeSessionId: "side-1" });
    expect(within(composer()).getByText("Lambda")).toBeInTheDocument();
    expect(within(composer()).queryByText("Sigma")).toBeNull();
    // The session title is the server's, though the list has no row for it.
    expect(screen.getByText("OL-1 · Old API kept")).toBeInTheDocument();
    // The opened record answered; nothing was looked up or created.
    expect(apiMock.getChatSession).not.toHaveBeenCalled();
    expect(apiMock.createChatSession).not.toHaveBeenCalled();
    expect(apiMock.setTipState).not.toHaveBeenCalled();
  });

  it("finds an unlisted side chat again after a reload, without clearing or swapping it", async () => {
    useChatStore.getState().setActiveSession("side-1");
    useChatStore.getState().setOpen(true);
    renderWithYsk(<ChatWindow />);

    await waitFor(() => expect(composer()).toHaveAttribute("data-agent", "Lambda"));
    expect(apiMock.getChatSession).toHaveBeenCalledWith("side-1");
    expect(useChatStore.getState().activeSessionId).toBe("side-1");
    expect(composer()).toHaveAttribute("data-disabled", "false");
  });

  it("never shows another agent while it looks the chat up", async () => {
    apiMock.getChatSession.mockReturnValue(new Promise(() => {}));
    useChatStore.getState().setActiveSession("side-1");
    renderWithYsk(<ChatWindow />);

    await waitFor(() => expect(apiMock.getChatSession).toHaveBeenCalled());
    expect(composer()).toHaveAttribute("data-agent", "");
    expect(screen.queryByText("Sigma")).toBeNull();
    expect(useChatStore.getState().activeSessionId).toBe("side-1");
  });

  it("does not fall back when the tip's agent is gone from the directory", async () => {
    apiMock.listAgents.mockResolvedValue([sigma]);
    useChatStore.getState().setActiveSession("side-1");
    renderWithYsk(<ChatWindow />);

    await waitFor(() => expect(banner()).toBeInTheDocument());
    expect(composer()).toHaveAttribute("data-agent", "");
    expect(screen.queryByText("Sigma")).toBeNull();
  });

  it("pins the tip banner above the conversation", async () => {
    useChatStore.getState().setActiveSession("side-1");
    useChatStore.getState().setOpen(true);
    renderWithYsk(<ChatWindow />);

    await waitFor(() => expect(banner()).toBeInTheDocument());
    const pinned = within(banner());
    expect(banner()).toHaveTextContent("✦Heads up·Kept the old API");
    expect(pinned.getByText("Clients still call it, so it stays until they move.")).toBeInTheDocument();
    expect(pinned.getByRole("link", { name: "Open OL-1" })).toHaveAttribute(
      "href",
      "/acme/issues/issue-1",
    );
    await waitFor(() =>
      expect(
        pinned.getByText("This is a side chat. It won't interrupt Lambda's current work."),
      ).toBeInTheDocument(),
    );
  });

  it("sends a common question into this chat, then gives way to the conversation", async () => {
    useChatStore.getState().setActiveSession("side-1");
    useChatStore.getState().setOpen(true);
    renderWithYsk(<ChatWindow />);
    const questions = await screen.findByRole("group", { name: "Common questions" });
    expect(
      within(questions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Tell me more", "Why does this matter?", "What will this affect?"]);
    await waitFor(() => expect(composer()).toHaveAttribute("data-agent", "Lambda"));

    fireEvent.click(within(questions).getByRole("button", { name: "Tell me more" }));

    await waitFor(() =>
      expect(within(screen.getByTestId("messages")).getByText("Tell me more")).toBeInTheDocument(),
    );
    expect(apiMock.sendChatMessage).toHaveBeenCalledExactlyOnceWith("side-1", "Tell me more", undefined);
    expect(apiMock.createChatSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Common questions" })).toBeNull();
    // The banner stays with the chat.
    expect(banner()).toBeInTheDocument();
  });

  it("shows no common questions once the chat has a visible message", async () => {
    messages = [
      {
        id: "earlier",
        chat_session_id: "side-1",
        role: "user",
        content: "Why?",
        task_id: null,
        created_at: "2026-10-13T00:01:00Z",
      },
    ];
    apiMock.listChatSessions.mockResolvedValue([sideChat]);
    useChatStore.getState().setActiveSession("side-1");
    renderWithYsk(<ChatWindow />);

    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("Why?"));
    expect(banner()).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Common questions" })).toBeNull();
  });

  it("keeps a new ordinary chat's agent while the list catches up after its first send", async () => {
    const TASK = "22222222-2222-4222-8222-222222222222";
    // The list refetch that would carry the new chat is slow.
    apiMock.listChatSessions.mockResolvedValueOnce([]).mockReturnValue(new Promise(() => {}));
    apiMock.createChatSession.mockResolvedValue({ ...sideChat, id: "new-1", agent_id: "agent-2", title: "hello", tip_source: undefined });
    apiMock.getPendingChatTask.mockImplementation(async (sessionId: string) =>
      sessionId === "new-1" ? { task_id: TASK, status: "queued", created_at: "2026-10-13T00:01:00Z" } : {},
    );
    apiMock.sendChatMessage.mockResolvedValue({
      message_id: "message-1",
      task_id: TASK,
      created_at: "2026-10-13T00:01:00Z",
      supports_queue: true,
    });
    useChatStore.getState().setOpen(true);
    renderWithYsk(<ChatWindow />);
    await waitFor(() => expect(composer()).toHaveAttribute("data-agent", "Sigma"));

    fireEvent.click(screen.getByRole("button", { name: "send from composer" }));

    await waitFor(() => expect(useChatStore.getState().activeSessionId).toBe("new-1"));
    expect(composer()).toHaveAttribute("data-agent", "Sigma");
    expect(composer()).toHaveAttribute("data-disabled", "false");
    expect(apiMock.getChatSession).not.toHaveBeenCalled();
  });

  it("leaves an ordinary chat's agent and empty state alone", async () => {
    renderWithYsk(<ChatWindow />);
    await waitFor(() => expect(composer()).toHaveAttribute("data-agent", "Sigma"));
    expect(document.querySelector("[data-ysk-side-chat-banner]")).toBeNull();
    expect(screen.queryByRole("group", { name: "Common questions" })).toBeNull();
  });
});

describe("the Chat page on a side chat", () => {
  // The page only reconciles its URL with the store for the workspace the
  // app is in.
  beforeEach(() => setCurrentWorkspace(WS_SLUG, WS_ID));
  afterEach(() => setCurrentWorkspace(null, null));

  it("opens ?session= for an unlisted side chat with its agent, banner and questions", async () => {
    const navigation = createNavigation({
      pathname: "/acme/chat",
      searchParams: new URLSearchParams("session=side-1"),
    });
    renderWithYsk(<ChatPage />, { navigation, queryClient: createYskQueryClient() });

    await waitFor(() => expect(composer()).toHaveAttribute("data-agent", "Lambda"));
    expect(useChatStore.getState().activeSessionId).toBe("side-1");
    expect(banner()).toHaveTextContent("Kept the old API");
    expect(screen.getByRole("group", { name: "Common questions" })).toBeInTheDocument();
    // The header shows the server's title.
    expect(screen.getByRole("button", { name: "OL-1 · Old API kept" })).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalledWith("/acme/chat");
  });
});
