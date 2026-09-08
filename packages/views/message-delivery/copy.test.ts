// @vitest-environment node

// Canonical key-mapping layer for the message-delivery UI. Component suites
// keep the rendering; the code→copy mapping itself is verified here against
// every stable wire code from server/internal/messagedelivery/README.md.

import { describe, expect, it } from "vitest";
import {
  canRetryMessageDelivery,
  messageDeliveryErrorCodeKey,
  messageDeliveryErrorKey,
  messageDeliverySourceKindKey,
  messageDeliveryStatusKey,
  messageTargetKey,
} from "./copy";

describe("messageDeliveryErrorKey", () => {
  it("maps every documented HTTP error code", () => {
    const codes = [
      "route_invalid",
      "route_installation_invalid",
      "route_member_not_bound",
      "route_target_not_member",
      "route_target_not_approved",
      "route_target_unverifiable",
      "route_target_unreachable",
      "route_topic_anchor_mismatch",
      "route_not_found",
      "route_revision_conflict",
      "route_already_exists",
      "route_disabled",
      "delivery_not_found",
      "delivery_not_retryable",
      "message_target_admin_required",
      "authorization_lost",
      "source_unavailable",
      "autopilot_no_originator",
      "autopilot_forbidden",
    ] as const;
    for (const code of codes) {
      expect(messageDeliveryErrorKey(code)).toBe(code);
    }
  });

  it("degrades unknown or absent codes to the generic message", () => {
    expect(messageDeliveryErrorKey(undefined)).toBe("generic");
    expect(messageDeliveryErrorKey("some_future_code")).toBe("generic");
  });
});

describe("messageDeliveryErrorCodeKey", () => {
  it("maps every documented pipeline error code", () => {
    const codes = [
      "route_disabled",
      "route_deleted",
      "source_archived",
      "source_missing",
      "condition_mismatch",
      "member_unbound",
      "installation_revoked",
      "installation_missing",
      "send_rejected",
      "send_transient",
      "sender_unavailable",
      "attempts_exhausted",
      "lease_expired",
      "send_ambiguous",
      "route_target_unverifiable",
      "route_target_unreachable",
      "route_topic_anchor_mismatch",
      "route_authorization_lost",
      "route_target_not_approved",
      "source_unresolved",
    ] as const;
    for (const code of codes) {
      expect(messageDeliveryErrorCodeKey(code)).toBe(code);
    }
  });

  it("degrades null/unknown codes", () => {
    expect(messageDeliveryErrorCodeKey(null)).toBe("unknown");
    expect(messageDeliveryErrorCodeKey("future_pipeline_code")).toBe("unknown");
  });
});

describe("messageDeliveryStatusKey", () => {
  it("maps the seven lifecycle statuses", () => {
    for (const s of [
      "queued",
      "sending",
      "sent",
      "failed",
      "uncertain",
      "cancelled",
      "suppressed",
    ] as const) {
      expect(messageDeliveryStatusKey(s)).toBe(s);
    }
  });

  it("degrades future statuses to unknown, never to sent", () => {
    expect(messageDeliveryStatusKey("delivered_read")).toBe("unknown");
  });
});

describe("messageDeliverySourceKindKey", () => {
  it("maps the documented source kinds", () => {
    expect(messageDeliverySourceKindKey("run_only")).toBe("run_only");
    expect(messageDeliverySourceKindKey("create_issue")).toBe("create_issue");
    expect(messageDeliverySourceKindKey("test_send")).toBe("test_send");
    expect(messageDeliverySourceKindKey("unknown")).toBe("unknown");
    expect(messageDeliverySourceKindKey("inbox")).toBe("unknown");
  });
});

describe("canRetryMessageDelivery", () => {
  it("only failed and uncertain are retryable (server 409s the rest)", () => {
    expect(canRetryMessageDelivery("failed")).toBe(true);
    expect(canRetryMessageDelivery("uncertain")).toBe(true);
    for (const s of ["queued", "sending", "sent", "cancelled", "suppressed", "whatever"]) {
      expect(canRetryMessageDelivery(s)).toBe(false);
    }
  });
});

describe("messageTargetKey", () => {
  it("mirrors the server's canonical target identity", () => {
    expect(messageTargetKey("member", { userId: "u1" })).toBe("member:u1");
    expect(messageTargetKey("group", { chatId: "oc_1" })).toBe("group:oc_1");
    expect(messageTargetKey("topic", { chatId: "oc_1", messageId: "om_1" })).toBe(
      "topic:oc_1:om_1",
    );
    expect(messageTargetKey("future", {})).toBe("future:unknown");
  });
});
