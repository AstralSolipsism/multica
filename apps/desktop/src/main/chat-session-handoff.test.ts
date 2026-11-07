// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OPEN_CHAT_SESSION_CHANNEL } from "../shared/chat-session-handoff";
import { MainRendererMessageQueue } from "../shared/main-renderer-messages";
import { AuthSessionCoordinator } from "./auth-session-coordinator";
import { MainWindowRegistry } from "./main-window-registry";
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
  const mainWindows = new MainWindowRegistry<FakeWindow>();
  const known = new Set<FakeWindow>();
  const closeIssueWindow = (window: FakeWindow) => issueWindows.delete(window);
  const accounts = new AuthSessionCoordinator<FakeWindow>((window) => {
    issueWindows.delete(window);
    mainWindows.remove(window);
  });
  const send = vi.fn();
  const focus = vi.fn();
  const queue = new MainRendererMessageQueue<FakeWindow>(send, (w) => mainWindows.has(w));
  const openMainWindow = vi.fn((slug: string) => {
    const window = { name: slug };
    mainWindows.add(window, slug);
    accounts.registerMainWindow(window);
    known.add(window);
    return window;
  });
  const mainWindow = openMainWindow("acme");
  openMainWindow.mockClear();
  const handoff = createChatSessionHandoff<FakeWindow, FakeWindow>({
    windowOf: (sender) => (known.has(sender) ? sender : null),
    issueWindows,
    accounts,
    queue,
    resolveTargetMainWindow: (slug) => mainWindows.findByWorkspace(slug) ?? openMainWindow(slug),
    focusMainWindow: focus,
  });
  const openIssueWindow = (name: string) => {
    const window = { name };
    known.add(window);
    issueWindows.add(window);
    accounts.registerIssueWindow(window);
    return window;
  };
  const delivered = () => {
    queue.setReady(mainWindow, OPEN_CHAT_SESSION_CHANNEL, true);
    return send.mock.calls.map(([, , payload]) => payload);
  };
  const closeMainWindow = (window: FakeWindow) => {
    handoff.forgetWindow(window);
    mainWindows.remove(window);
    accounts.unregisterMainWindow(window);
    queue.release(window, mainWindows.mostRecent());
  };
  return { accounts, handoff, mainWindow, mainWindows, queue, send, focus,
    openMainWindow, openIssueWindow, closeIssueWindow, closeMainWindow, delivered };
}

describe("createChatSessionHandoff", () => {
  it("takes a session from an issue window of the main window's account", () => {
    const { accounts, handoff, mainWindow, openIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");

    expect(handoff.handleRequest({ sender: issue }, request)).toEqual({ ok: true });
    expect(delivered()).toEqual([request]);
  });

  it("refuses an issue window that has not confirmed its account yet", () => {
    const { accounts, handoff, mainWindow, openIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
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
    const { accounts, handoff, mainWindow, openIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
    const stale = openIssueWindow("OL-1");
    accounts.reportIssue(stale, "user-2");

    expect(handoff.handleRequest({ sender: stale }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses an issue window left over after the main window switched accounts", () => {
    const { accounts, handoff, mainWindow, openIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");
    accounts.reportMain(mainWindow, "user-2");

    expect(handoff.handleRequest({ sender: issue }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses an issue window that is no longer open", () => {
    const { accounts, handoff, mainWindow, openIssueWindow, closeIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");
    // Closing drops it from the open set before its account entry goes.
    closeIssueWindow(issue);

    expect(handoff.handleRequest({ sender: issue }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses the main window itself and senders that are no window", () => {
    const { accounts, handoff, mainWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");

    expect(handoff.handleRequest({ sender: mainWindow }, request).ok).toBe(false);
    expect(handoff.handleRequest({ sender: { name: "devtools" } }, request).ok).toBe(false);
    expect(delivered()).toEqual([]);
  });

  it("refuses a malformed request from a trusted window", () => {
    const { accounts, handoff, mainWindow, openIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");

    expect(
      handoff.handleRequest({ sender: issue }, { workspaceSlug: "acme", sessionId: "/acme/settings" }),
    ).toEqual({ ok: false, reason: "invalid_request" });
    expect(delivered()).toEqual([]);
  });

  it("drops a waiting session when the main window's account changes", () => {
    const { accounts, handoff, mainWindow, openIssueWindow, delivered } = setup();
    accounts.reportMain(mainWindow, "user-1");
    const issue = openIssueWindow("OL-1");
    accounts.reportIssue(issue, "user-1");
    // Queued: the main renderer's listener is not ready yet.
    expect(handoff.handleRequest({ sender: issue }, request)).toEqual({ ok: true });

    handoff.dropForAccountChange();

    expect(delivered()).toEqual([]);
  });
});


describe("workspace isolation", () => {
  function trusted() {
    const f = setup();
    f.accounts.reportMain(f.mainWindow, "user-1");
    const issue = f.openIssueWindow("OL-1");
    f.accounts.reportIssue(issue, "user-1");
    return { ...f, issue };
  }

  it("delivers only to the requested workspace even when another was focused last", () => {
    const f = trusted();
    const other = f.openMainWindow("butter");
    f.queue.setReady(other, OPEN_CHAT_SESSION_CHANNEL, true);
    f.queue.setReady(f.mainWindow, OPEN_CHAT_SESSION_CHANNEL, true);
    expect(f.handoff.handleRequest({ sender: f.issue }, request)).toEqual({ ok: true });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.mainWindow, OPEN_CHAT_SESSION_CHANNEL, request);
    expect(f.focus).toHaveBeenCalledExactlyOnceWith(f.mainWindow);
  });

  it("creates one target for two requests and waits for its renderer", () => {
    const f = trusted();
    f.queue.setReady(f.mainWindow, OPEN_CHAT_SESSION_CHANNEL, true);
    const targetRequest = { ...request, workspaceSlug: "butter" };
    f.handoff.handleRequest({ sender: f.issue }, targetRequest);
    f.handoff.handleRequest({ sender: f.issue }, targetRequest);
    expect(f.openMainWindow).toHaveBeenCalledExactlyOnceWith("butter");
    expect(f.send).not.toHaveBeenCalled();
    const target = f.mainWindows.findByWorkspace("butter")!;
    f.queue.setReady(target, OPEN_CHAT_SESSION_CHANNEL, true);
    expect(f.send.mock.calls).toEqual([
      [target, OPEN_CHAT_SESSION_CHANNEL, targetRequest],
      [target, OPEN_CHAT_SESSION_CHANNEL, targetRequest],
    ]);
  });

  it("discards a closed target's pending sessions before releasing to a successor", () => {
    const f = trusted();
    const other = f.openMainWindow("butter");
    f.queue.setReady(other, OPEN_CHAT_SESSION_CHANNEL, true);
    f.handoff.handleRequest({ sender: f.issue }, request);
    f.closeMainWindow(f.mainWindow);
    f.queue.setReady(other, OPEN_CHAT_SESSION_CHANNEL, true);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("clears every window's waiting sessions on account change", () => {
    const f = trusted();
    f.handoff.handleRequest({ sender: f.issue }, request);
    f.handoff.handleRequest({ sender: f.issue }, { ...request, workspaceSlug: "butter" });
    f.handoff.dropForAccountChange();
    for (const window of f.mainWindows.all()) f.queue.setReady(window, OPEN_CHAT_SESSION_CHANNEL, true);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("recreates the requested workspace after all main windows close", () => {
    const f = trusted();
    f.closeMainWindow(f.mainWindow);
    expect(f.handoff.handleRequest({ sender: f.issue }, request)).toEqual({ ok: true });
    const target = f.mainWindows.findByWorkspace("acme")!;
    expect(target).not.toBe(f.mainWindow);
    f.queue.setReady(target, OPEN_CHAT_SESSION_CHANNEL, true);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(target, OPEN_CHAT_SESSION_CHANNEL, request);
  });
});
