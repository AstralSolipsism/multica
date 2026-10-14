// @vitest-environment jsdom

/**
 * "Ask about this" (OL-362) through the real provider: from the card and from
 * the archive, greyed out with its reason when the tip's agent cannot chat,
 * a server refusal shown the same way, and where the opened side chat goes —
 * the floating chat, the Chat page when the floating chat is off, or the
 * provider's opener (a desktop issue window). Asking never changes the tip's
 * state and never writes into a draft.
 */

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatStore,
  DRAFT_NEW_SESSION,
  registerChatStore,
  useChatStore,
} from "@multica/core/chat";
import { chatKeys } from "@multica/core/chat/queries";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import type { Agent, ChatSession, MemberWithUser, StorageAdapter } from "@multica/core/types";
import { tipDisplayLedger } from "@multica/core/you-should-know";
import { YouShouldKnowArchiveSection } from "../archive/archive-section";
import {
  createNavigation,
  flush,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
  WS_ID,
} from "../../test/you-should-know";
import {
  cachedState,
  cardButton,
  installFakeTipServer,
  openCard,
  RowAnchor,
} from "../../test/you-should-know-layers";

const apiMock = vi.hoisted(() => ({
  listActiveTips: vi.fn(),
  listIssueTips: vi.fn(),
  setTipState: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkspaces: vi.fn(),
  listAgents: vi.fn(),
  listMembers: vi.fn(),
  openTipChat: vi.fn(),
}));
vi.mock("@multica/core/api", () => ({ api: apiMock }));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

function makeAgent(overrides: Partial<Agent> = {}): Agent {
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

function sideChat(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
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
        tag: "you_should_know",
        line: "The agent put the feature behind a flag",
        title: "Old API kept",
        explanation: "Because.",
        status: "valid",
        overturned_reason: null,
        overturned_by_comment_id: null,
      },
    },
    ...overrides,
  };
}

function refusal(status: number, code: string) {
  return Object.assign(new Error("refused"), { status, body: { error: "refused", code } });
}

let storageValues: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  toastError.mockReset();
  apiMock.listAgents.mockResolvedValue([makeAgent()]);
  apiMock.listMembers.mockResolvedValue([me]);
  apiMock.openTipChat.mockResolvedValue(sideChat());
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
  useCommentDraftStore.setState({ drafts: {} });
  storageValues = new Map();
  const storage: StorageAdapter = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => {
      storageValues.set(key, value);
    },
    removeItem: (key) => {
      storageValues.delete(key);
    },
  };
  registerChatStore(createChatStore({ storage }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function serveArchive(...tips: ReturnType<typeof makeTip>[]) {
  apiMock.listIssueTips.mockResolvedValue({ tips });
}

function Archive() {
  return <YouShouldKnowArchiveSection issueId="issue-1" identifier="OL-1" />;
}

function askButton(): HTMLElement {
  return screen.getByRole("button", { name: "Ask about this" });
}

async function expandArchivedTip(line: string | RegExp) {
  await settle();
  fireEvent.click(screen.getByRole("button", { name: line }));
  // The button reads the agent and member directories once it mounts.
  await flush();
}

describe("Ask about this — on the card", () => {
  it("opens the side chat in the floating window and leaves the tip as it was", async () => {
    const { serveTips } = installFakeTipServer(apiMock);
    serveTips(makeTip({ explanation: "Because." }));
    const { queryClient } = renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    fireEvent.click(cardButton("Learn more"));

    fireEvent.click(cardButton("Ask about this"));
    await flush();

    expect(apiMock.openTipChat).toHaveBeenCalledExactlyOnceWith("tip-1");
    const chat = useChatStore.getState();
    expect(chat.activeSessionId).toBe("side-1");
    expect(chat.isOpen).toBe(true);
    // The floating chat can show the session before the list carries it.
    expect(queryClient.getQueryData(chatKeys.session(WS_ID, "side-1"))).toEqual(sideChat());
    // Not known, not dismissed: the tip and its card stay.
    expect(apiMock.setTipState).not.toHaveBeenCalled();
    expect(cachedState(queryClient, "tip-1")).toBeNull();
    expect(cardButton("Got it")).toBeInTheDocument();
  });

  it("is only offered once Learn more has opened the explanation", async () => {
    const { serveTips } = installFakeTipServer(apiMock);
    serveTips(makeTip());
    renderWithYsk(<RowAnchor issueId="issue-1" />);
    await settle();
    openCard();
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
  });
});

describe("Ask about this — in the archive", () => {
  it("opens the side chat for a tip that is no longer valid too", async () => {
    serveArchive(makeTip({ id: "old", line: "Was true", status: "overturned" }));
    apiMock.openTipChat.mockResolvedValue(sideChat({ id: "side-old" }));
    renderWithYsk(<Archive />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "No longer valid" }));
    fireEvent.click(screen.getByRole("button", { name: /Was true/ }));

    fireEvent.click(askButton());
    await flush();

    expect(apiMock.openTipChat).toHaveBeenCalledExactlyOnceWith("old");
    expect(useChatStore.getState().activeSessionId).toBe("side-old");
    expect(apiMock.setTipState).not.toHaveBeenCalled();
  });

  it("goes to the Chat page when the floating chat is off in Settings", async () => {
    serveArchive(makeTip({ line: "Kept the old API" }));
    useChatStore.getState().setFloatingChatEnabled(false);
    const navigation = createNavigation();
    renderWithYsk(<Archive />, { navigation });
    await expandArchivedTip(/Kept the old API/);

    fireEvent.click(askButton());
    await flush();

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/acme/chat?session=side-1");
    expect(useChatStore.getState().isOpen).toBe(false);
  });

  it("hands the session to the provider's opener instead of this window", async () => {
    serveArchive(makeTip({ line: "Kept the old API" }));
    const openSideChat = vi.fn();
    const navigation = createNavigation();
    renderWithYsk(<Archive />, { navigation, openSideChat });
    await expandArchivedTip(/Kept the old API/);

    fireEvent.click(askButton());
    await flush();

    expect(openSideChat).toHaveBeenCalledExactlyOnceWith("side-1");
    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("keeps every draft where it was", async () => {
    serveArchive(makeTip({ line: "Kept the old API" }));
    const chat = useChatStore.getState();
    chat.setActiveSession("other-session");
    chat.setInputDraft("other-session", "half a thought");
    chat.setInputDraft(DRAFT_NEW_SESSION, "a new chat I was writing");
    renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);

    fireEvent.click(askButton());
    await flush();

    const after = useChatStore.getState();
    expect(after.activeSessionId).toBe("side-1");
    expect(after.inputDrafts).toEqual({
      "other-session": "half a thought",
      [DRAFT_NEW_SESSION]: "a new chat I was writing",
    });
  });
});

describe("Ask about this — an agent the member cannot chat with", () => {
  it.each([
    [
      "a personal agent of someone else",
      makeAgent({ permission_mode: "private", invocation_targets: [] }),
      "You don't have access to chat with Lambda",
    ],
    ["an archived agent", makeAgent({ archived_at: "2026-10-12T00:00:00Z" }), "Lambda is archived"],
    ["an agent without a runtime", makeAgent({ runtime_id: "" }), "Lambda isn't connected to a runtime"],
  ])("greys out for %s and says why", async (_case, agent, reason) => {
    apiMock.listAgents.mockResolvedValue([agent]);
    serveArchive(makeTip({ line: "Kept the old API" }));
    renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);

    const button = askButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(reason);
    fireEvent.click(button);
    await flush();
    expect(apiMock.openTipChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeSessionId).toBeNull();
  });

  it("treats an agent the member cannot see as one without access", async () => {
    apiMock.listAgents.mockResolvedValue([]);
    serveArchive(makeTip({ line: "Kept the old API" }));
    renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);
    expect(askButton()).toHaveAccessibleDescription("You don't have access to chat with this agent");
  });

  it("takes the server's reason when it refuses, and greys out the same way", async () => {
    apiMock.openTipChat.mockRejectedValue(refusal(409, "agent_no_runtime"));
    serveArchive(makeTip({ line: "Kept the old API" }));
    renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);

    fireEvent.click(askButton());
    await flush();

    expect(toastError).toHaveBeenCalledExactlyOnceWith("Lambda isn't connected to a runtime");
    expect(askButton()).toHaveAttribute("aria-disabled", "true");
    expect(askButton()).toHaveAccessibleDescription("Lambda isn't connected to a runtime");
    expect(useChatStore.getState().activeSessionId).toBeNull();
    // A second press does not ask again.
    fireEvent.click(askButton());
    await flush();
    expect(apiMock.openTipChat).toHaveBeenCalledTimes(1);
  });

  it("lets the refusal go once the directories speak for the agent again", async () => {
    apiMock.openTipChat.mockRejectedValue(refusal(409, "agent_archived"));
    serveArchive(makeTip({ line: "Kept the old API" }));
    const { queryClient } = renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);

    // The refetch the refusal asks for now sees the archive.
    apiMock.listAgents.mockResolvedValue([makeAgent({ archived_at: "2026-10-13T00:00:00Z" })]);
    fireEvent.click(askButton());
    await flush();
    expect(askButton()).toHaveAccessibleDescription("Lambda is archived");

    // Unarchived later: the button comes back without a remount.
    apiMock.listAgents.mockResolvedValue([makeAgent()]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    });
    await flush();
    await act(async () => {
      await queryClient.refetchQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes("agents") });
    });
    await flush();
    expect(askButton()).toHaveAttribute("aria-disabled", "false");
  });

  it("opens a refusal for an agent it cannot name with a capital", async () => {
    // The directories are still loading: the server has the last word.
    apiMock.listAgents.mockReturnValue(new Promise(() => {}));
    apiMock.openTipChat.mockRejectedValue(refusal(409, "agent_archived"));
    serveArchive(makeTip({ line: "Kept the old API" }));
    renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);

    fireEvent.click(askButton());
    await flush();

    expect(toastError).toHaveBeenCalledExactlyOnceWith("This agent is archived");
  });

  it("says it could not open on any other failure, and stays available", async () => {
    apiMock.openTipChat.mockRejectedValueOnce(new Error("offline"));
    serveArchive(makeTip({ line: "Kept the old API" }));
    renderWithYsk(<Archive />);
    await expandArchivedTip(/Kept the old API/);

    fireEvent.click(askButton());
    await flush();

    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't open the side chat. Try again.");
    expect(askButton()).toHaveAttribute("aria-disabled", "false");
  });
});

describe("Ask about this — localized", () => {
  it("reads 追问 and gives the reason in Chinese", async () => {
    apiMock.listAgents.mockResolvedValue([makeAgent({ archived_at: "2026-10-12T00:00:00Z" })]);
    serveArchive(makeTip({ line: "Kept the old API" }));
    renderWithYsk(<Archive />, { locale: "zh-Hans" });
    await expandArchivedTip(/Kept the old API/);

    const button = screen.getByRole("button", { name: "追问" });
    expect(button).toHaveAccessibleDescription("Lambda 已归档");
  });
});
