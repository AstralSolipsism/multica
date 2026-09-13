// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ApiError } from "@multica/core/api";
import {
  anchorTimeMs,
  chatIdSuffix,
  larkDiscoveryErrorKey,
  mergeDiscoveredChats,
  mergeMessageAnchors,
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
