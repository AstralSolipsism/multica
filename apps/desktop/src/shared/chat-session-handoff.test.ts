// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  OPEN_CHAT_SESSION_CHANNEL,
  parseChatSessionHandoff,
} from "./chat-session-handoff";
import { parseMainRendererChannelState } from "./main-renderer-messages";

const SESSION = "0199a4b2-1c3d-7e4f-8a5b-6c7d8e9f0a1b";

describe("parseChatSessionHandoff", () => {
  it("accepts a workspace slug and a session id", () => {
    expect(parseChatSessionHandoff({ workspaceSlug: "acme", sessionId: SESSION })).toEqual({
      workspaceSlug: "acme",
      sessionId: SESSION,
    });
  });

  it("drops anything else the renderer adds", () => {
    expect(
      parseChatSessionHandoff({ workspaceSlug: "acme", sessionId: SESSION, path: "/settings" }),
    ).toEqual({ workspaceSlug: "acme", sessionId: SESSION });
  });

  it.each([
    null,
    "acme",
    { workspaceSlug: "acme" },
    { sessionId: SESSION },
    { workspaceSlug: "Acme", sessionId: SESSION },
    { workspaceSlug: "../acme", sessionId: SESSION },
    { workspaceSlug: "acme", sessionId: "not-a-session" },
    { workspaceSlug: "acme", sessionId: `${SESSION}?x=1` },
    { workspaceSlug: 1, sessionId: SESSION },
  ])("rejects %j", (value) => {
    expect(parseChatSessionHandoff(value)).toBeNull();
  });
});

describe("the main-renderer queue", () => {
  it("allowlists the chat-session channel", () => {
    expect(
      parseMainRendererChannelState({ channel: OPEN_CHAT_SESSION_CHANNEL, ready: true }),
    ).toEqual({ channel: OPEN_CHAT_SESSION_CHANNEL, ready: true });
  });
});
