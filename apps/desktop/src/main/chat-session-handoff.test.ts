// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MainRendererMessageQueue } from "../shared/main-renderer-messages";
import { OPEN_CHAT_SESSION_CHANNEL } from "../shared/chat-session-handoff";
import { handleChatSessionHandoff } from "./chat-session-handoff";

const SESSION = "0199a4b2-1c3d-7e4f-8a5b-6c7d8e9f0a1b";
const request = { workspaceSlug: "acme", sessionId: SESSION };

describe("handleChatSessionHandoff", () => {
  it("delivers a valid request from an issue window of the current account", () => {
    const deliver = vi.fn();
    expect(handleChatSessionHandoff(request, { fromCurrentIssueWindow: true, deliver })).toEqual({
      ok: true,
    });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("ignores any other sender", () => {
    const deliver = vi.fn();
    expect(handleChatSessionHandoff(request, { fromCurrentIssueWindow: false, deliver })).toEqual({
      ok: false,
      reason: "untrusted_sender",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses a malformed request", () => {
    const deliver = vi.fn();
    expect(
      handleChatSessionHandoff(
        { workspaceSlug: "acme", sessionId: "/acme/settings" },
        { fromCurrentIssueWindow: true, deliver },
      ),
    ).toEqual({ ok: false, reason: "invalid_request" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("waits for the main window's listener, like every main-renderer message", () => {
    // index.ts delivers through dispatchToMainRenderer, which enqueues here
    // and focuses (or recreates) the main window.
    const queue = new MainRendererMessageQueue();
    const send = vi.fn();
    handleChatSessionHandoff(request, {
      fromCurrentIssueWindow: true,
      deliver: (handoff) => queue.enqueue(OPEN_CHAT_SESSION_CHANNEL, handoff, send),
    });
    expect(send).not.toHaveBeenCalled();

    queue.setReady(OPEN_CHAT_SESSION_CHANNEL, true, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(OPEN_CHAT_SESSION_CHANNEL, request);
  });
});
