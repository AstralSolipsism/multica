// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OPEN_CHAT_SESSION_CHANNEL } from "../shared/chat-session-handoff";
import { MainRendererMessageQueue } from "../shared/main-renderer-messages";
import { AuthSessionCoordinator } from "./auth-session-coordinator";
import { createChatSessionHandoff } from "./chat-session-handoff";

const SESSION = "0199a4b2-1c3d-7e4f-8a5b-6c7d8e9f0a1b";
const request = { workspaceSlug: "acme", sessionId: SESSION };

type FakeWindow = { name: string };

/**
 * The handoff as main/index.ts wires it — a real account coordinator, a real
 * main-renderer queue and the open issue-window registry — with windows that
 * are their own IPC senders.
 */
function setup() {
  const issueWindows = new Set<FakeWindow>();
  const closeIssueWindow = (window: FakeWindow) => issueWindows.delete(window);
  const accounts = new AuthSessionCoordinator<FakeWindow>((window) => {
    issueWindows.delete(window);
  });
  const queue = new MainRendererMessageQueue();
  const send = vi.fn();
  const known = new Set<FakeWindow>();
  const handoff = createChatSessionHandoff<FakeWindow, FakeWindow>({
    windowOf: (sender) => (known.has(sender) ? sender : null),
    issueWindows,
    accounts,
    queue,
    dispatch: (session) => queue.enqueue(OPEN_CHAT_SESSION_CHANNEL, session, send),
  });
  const mainWindow: FakeWindow = { name: "main" };
  known.add(mainWindow);
  const openIssueWindow = (name: string) => {
    const window: FakeWindow = { name };
    known.add(window);
    issueWindows.add(window);
    accounts.registerIssueWindow(window);
    return window;
  };
  /** Delivered sessions once the main renderer's listener is ready. */
  const delivered = () => {
    queue.setReady(OPEN_CHAT_SESSION_CHANNEL, true, send);
    return send.mock.calls.map(([, payload]) => payload);
  };
  return { accounts, handoff, mainWindow, openIssueWindow, closeIssueWindow, delivered };
}

describe("createChatSessionHandoff", () => {
  it("takes a session from an issue window of the main window's account", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");

    expect(handoff.handleRequest({ sender: issue }, request)).toEqual({ ok: true });
    expect(delivered()).toEqual([request]);
  });

  it("refuses an issue window that has not confirmed its account yet", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const issue = openIssueWindow("OL-1");

    expect(handoff.handleRequest({ sender: issue }, request)).toEqual({
      ok: false,
      reason: "untrusted_sender",
    });
    expect(delivered()).toEqual([]);
  });

  it("refuses while the main window has no account", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");

    expect(handoff.handleRequest({ sender: issue }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses an issue window of another account", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const stale = openIssueWindow("OL-1");
    accounts.reportIssue(stale, "user-2");

    expect(handoff.handleRequest({ sender: stale }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses an issue window left over after the main window switched accounts", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");
    accounts.reportMain("user-2");

    expect(handoff.handleRequest({ sender: issue }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses an issue window that is no longer open", () => {
    const { accounts, handoff, openIssueWindow, closeIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");
    // Closing drops it from the open set before its account entry goes.
    closeIssueWindow(issue);

    expect(handoff.handleRequest({ sender: issue }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses the main window itself and senders that are no window", () => {
    const { accounts, handoff, mainWindow, delivered } = setup();
    accounts.reportMain("user-1");

    expect(handoff.handleRequest({ sender: mainWindow }, request).ok).toBe(false);
    expect(handoff.handleRequest({ sender: { name: "devtools" } }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses a malformed request from a trusted window", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");

    expect(
      handoff.handleRequest({ sender: issue }, { workspaceSlug: "acme", sessionId: "/acme/settings" }),
    ).toEqual({ ok: false, reason: "invalid_request" });
    expect(delivered()).toEqual([]);
  });

  it("drops a waiting session when the main window's account changes", () => {
    const { accounts, handoff, openIssueWindow, delivered } = setup();
    accounts.reportMain("user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");
    // Queued: the main renderer's listener is not ready yet.
    expect(handoff.handleRequest({ sender: issue }, request)).toEqual({ ok: true });

    handoff.dropForAccountChange();

    expect(delivered()).toEqual([]);
  });
});
