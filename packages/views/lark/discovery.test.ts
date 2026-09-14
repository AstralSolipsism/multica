// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ApiError } from "@multica/core/api";
import {
  anchorTimeMs,
  candidateDisplayName,
  candidateTimeMs,
  chatIdSuffix,
  larkDiscoveryErrorKey,
  larkPrivateChatErrorKey,
  mergeConversationDraft,
  mergeDiscoveredChats,
  mergeMessageAnchors,
  sameConversationChats,
  type LarkConversationDraftChat,
} from "./discovery";

// Canonical matrices for the OL-74 pickers' pure helpers. The component
// suites render the states; every code → copy-key mapping lives here.

function apiErr(status: number, code?: string) {
  return new ApiError("boom", status, "status", code ? { error: "x", code } : undefined);
}

describe("larkDiscoveryErrorKey", () => {
  it.each([
    [apiErr(403, "lark_discovery_forbidden"), "forbidden"],
    [apiErr(403, "lark_discovery_permission_denied"), "permission_denied"],
    [apiErr(503, "lark_discovery_unsupported"), "unsupported"],
    [apiErr(503, "lark_discovery_unavailable"), "unavailable"],
    [apiErr(429, "lark_discovery_rate_limited"), "rate_limited"],
    [apiErr(400, "lark_discovery_invalid_cursor"), "invalid_cursor"],
    [apiErr(404, "lark_discovery_chat_unavailable"), "chat_unavailable"],
    [apiErr(410, "lark_discovery_message_unavailable"), "message_unavailable"],
    [apiErr(409, "lark_installation_inactive"), "installation_inactive"],
    [apiErr(404, "lark_installation_not_found"), "installation_not_found"],
    [apiErr(502, "lark_discovery_invalid_response"), "invalid_response"],
    [apiErr(400, "lark_discovery_invalid_request"), "invalid_request"],
  ] as const)("%s → %s", (err, key) => {
    expect(larkDiscoveryErrorKey(err)).toBe(key);
  });

  it("maps an uncoded router 404 (pre-discovery server) to unsupported", () => {
    expect(larkDiscoveryErrorKey(apiErr(404))).toBe("unsupported");
  });

  it("degrades unknown codes and non-API errors to generic", () => {
    expect(larkDiscoveryErrorKey(apiErr(500, "some_future_code"))).toBe("generic");
    expect(larkDiscoveryErrorKey(new Error("network down"))).toBe("generic");
  });
});

describe("mergeDiscoveredChats", () => {
  it("dedupes by chat_id across pages, first occurrence wins", () => {
    const a = { chat_id: "oc_a", name: "A", description: "", avatar: "", external: false, chat_status: "normal" };
    const b = { chat_id: "oc_b", name: "B", description: "", avatar: "", external: true, chat_status: "normal" };
    const aMoved = { ...a, name: "A moved" };
    const merged = mergeDiscoveredChats([
      { items: [a, b] },
      { items: [] },
      { items: [aMoved] },
    ]);
    expect(merged.map((c) => c.chat_id)).toEqual(["oc_a", "oc_b"]);
    expect(merged[0]?.name).toBe("A");
  });

  it("tolerates empty/undefined pages", () => {
    expect(mergeDiscoveredChats(undefined)).toEqual([]);
    expect(mergeDiscoveredChats([{ items: [] }])).toEqual([]);
  });
});

describe("mergeMessageAnchors", () => {
  const anchor = (id: string) => ({
    message_id: id,
    chat_id: "oc_a",
    message_type: "text",
    summary: id,
    create_time: "1700000000000",
    sender: { type: "user" as const },
  });

  it("dedupes by message_id and keeps order", () => {
    const merged = mergeMessageAnchors([{ items: [anchor("om_1"), anchor("om_2")] }, { items: [anchor("om_1")] }]);
    expect(merged.map((m) => m.message_id)).toEqual(["om_1", "om_2"]);
  });
});

describe("anchorTimeMs", () => {
  it("parses epoch-millisecond strings and rejects drift", () => {
    expect(anchorTimeMs("1700000000000")).toBe(1700000000000);
    expect(anchorTimeMs("")).toBeNull();
    expect(anchorTimeMs("2026-09-13T00:00:00Z")).toBeNull();
    expect(anchorTimeMs("-5")).toBeNull();
    expect(anchorTimeMs("12.5")).toBeNull();
  });
});

describe("chatIdSuffix", () => {
  it("shows the last 6 chars, or the whole short id", () => {
    expect(chatIdSuffix("oc_abcdef1234")).toBe("ef1234");
    expect(chatIdSuffix("oc_x")).toBe("oc_x");
  });
});

describe("larkPrivateChatErrorKey", () => {
  it.each([
    [apiErr(403, "lark_discovery_forbidden"), "forbidden"],
    [apiErr(403, "lark_conversation_invocation_denied"), "invocation_denied"],
    [apiErr(409, "lark_conversation_limit_exceeded"), "limit_exceeded"],
    [apiErr(410, "lark_private_chat_candidate_unavailable"), "candidate_unavailable"],
    [apiErr(400, "lark_conversation_invalid_request"), "invalid_request"],
    [apiErr(409, "lark_installation_inactive"), "installation_inactive"],
    [apiErr(404, "lark_installation_not_found"), "installation_not_found"],
    [apiErr(503, "lark_discovery_unsupported"), "unsupported"],
  ] as const)("%s → %s", (err, key) => {
    expect(larkPrivateChatErrorKey(err)).toBe(key);
  });

  it("maps an uncoded router 404 (pre-discovery server) to unsupported", () => {
    expect(larkPrivateChatErrorKey(apiErr(404))).toBe("unsupported");
  });

  it("degrades unknown codes and non-API errors to generic", () => {
    expect(larkPrivateChatErrorKey(apiErr(500, "some_future_code"))).toBe("generic");
    expect(larkPrivateChatErrorKey(new Error("network down"))).toBe("generic");
  });
});

describe("candidateTimeMs", () => {
  it("parses RFC3339 strings and rejects drift", () => {
    expect(candidateTimeMs("2026-09-13T12:00:00Z")).toBe(Date.parse("2026-09-13T12:00:00Z"));
    expect(candidateTimeMs("")).toBeNull();
    expect(candidateTimeMs("not-a-date")).toBeNull();
  });
});

describe("candidateDisplayName", () => {
  it("returns the name only when identity_status confirms availability", () => {
    expect(candidateDisplayName({ display_name: "Alice", identity_status: "name_available" })).toBe("Alice");
    // id_only and unknown statuses never show a name…
    expect(candidateDisplayName({ display_name: "", identity_status: "id_only" })).toBeNull();
    expect(candidateDisplayName({ display_name: "Alice", identity_status: "some_future_status" })).toBeNull();
    // …and drift (available but empty) never fabricates one.
    expect(candidateDisplayName({ display_name: "  ", identity_status: "name_available" })).toBeNull();
  });
});

describe("sameConversationChats", () => {
  const g = (id: string) => ({ chat_id: id, chat_type: "group" });
  it("compares target sets order-independently and tolerates null", () => {
    expect(sameConversationChats([g("oc_a"), { chat_id: "oc_b", chat_type: "p2p" }], [{ chat_id: "oc_b", chat_type: "p2p" }, g("oc_a")])).toBe(true);
    expect(sameConversationChats(null, [])).toBe(true);
    expect(sameConversationChats(undefined, [g("oc_a")])).toBe(false);
    // Type is part of identity.
    expect(sameConversationChats([g("oc_a")], [{ chat_id: "oc_a", chat_type: "p2p" }])).toBe(false);
    expect(sameConversationChats([g("oc_a")], [g("oc_a"), g("oc_b")])).toBe(false);
  });
});

describe("mergeConversationDraft", () => {
  // baseline/incoming are wire-shaped grant chats; the draft is picker-shaped.
  const wg = (id: string) => ({ chat_id: id, chat_type: "group" });
  const wp = (id: string) => ({ chat_id: id, chat_type: "p2p" });
  const g = (chatId: string, name = ""): LarkConversationDraftChat => ({ chatId, name, chat_type: "group" });
  const p = (chatId: string, name = ""): LarkConversationDraftChat => ({ chatId, name, chat_type: "p2p" });
  const keys = (rows: LarkConversationDraftChat[]) => rows.map((r) => `${r.chat_type}:${r.chatId}`);

  it("adopts the fresh grant verbatim when the draft has no local edits", () => {
    // The OL-76 re-review repro: baseline G+A, upstream swapped A→B, confirm
    // returned G+B+C — the next save must not resurrect A or drop B.
    const merged = mergeConversationDraft(
      [wg("oc_g"), wp("oc_a")],
      [wg("oc_g"), wp("oc_b"), wp("oc_c")],
      [g("oc_g"), p("oc_a")],
    );
    expect(keys(merged)).toEqual(["group:oc_g", "p2p:oc_b", "p2p:oc_c"]);
  });

  it("replays explicit local additions and removals on the new baseline", () => {
    const merged = mergeConversationDraft(
      [wg("oc_g"), wp("oc_a")],
      [wg("oc_g"), wp("oc_a"), wp("oc_c")],
      // User removed oc_a and added oc_h locally (unsaved).
      [g("oc_g"), g("oc_h", "H")],
    );
    expect(keys(merged)).toEqual(["group:oc_g", "p2p:oc_c", "group:oc_h"]);
    // Names of surviving picks are preserved.
    expect(merged.find((m) => m.chatId === "oc_h")?.name).toBe("H");
  });

  it("lets an upstream removal win over a chat the user merely kept", () => {
    const merged = mergeConversationDraft(
      [wg("oc_g"), wp("oc_a")],
      [wg("oc_g")],
      [g("oc_g"), p("oc_a")],
    );
    expect(keys(merged)).toEqual(["group:oc_g"]);
  });

  it("keeps local additions that a confirm made redundant exactly once", () => {
    // User added oc_c to the draft; the confirmed grant already contains it.
    const merged = mergeConversationDraft(
      [wg("oc_g")],
      [wg("oc_g"), wp("oc_c")],
      [g("oc_g"), p("oc_c", "C")],
    );
    expect(keys(merged)).toEqual(["group:oc_g", "p2p:oc_c"]);
    expect(merged[1]?.name).toBe("C");
  });

  it("clears the draft when the grant was revoked upstream", () => {
    expect(mergeConversationDraft([wg("oc_g")], null, [g("oc_g")])).toEqual([]);
    expect(mergeConversationDraft([wg("oc_g")], [], [g("oc_g"), g("oc_h")])).toEqual([g("oc_h")]);
  });
});
