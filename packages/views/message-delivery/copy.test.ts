// @vitest-environment node

// Canonical key-mapping layer for the message-delivery UI. Component suites
// keep the rendering; the code→copy mapping itself is verified here against
// every stable wire code from server/internal/messagedelivery/README.md.

import { describe, expect, it } from "vitest";
import {
  confirmedRunPages,
  canRetryMessageDelivery,
  isSourceTargetApproved,
  messageDeliveryErrorCodeKey,
  messageDeliveryErrorKey,
  messageDeliverySourceKindKey,
  messageDeliveryStatusKey,
  messageSourceScopeKey,
  messageTargetKey,
  personalEventTypeKey,
  teamEventKey,
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
      "message_no_originator",
      "message_forbidden",
      "route_not_self",
      "authorization_lost",
      "source_unavailable",
      "autopilot_no_originator",
      "autopilot_forbidden",
      "response_unconfirmed",
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
      "recipient_muted",
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
  });

  it("maps the OL-27 source scopes (personal/team records surface)", () => {
    expect(messageDeliverySourceKindKey("inbox")).toBe("inbox");
    expect(messageDeliverySourceKindKey("activity")).toBe("activity");
    expect(messageDeliverySourceKindKey("comment")).toBe("comment");
    expect(messageDeliverySourceKindKey("some_future_scope")).toBe("unknown");
  });
});

describe("messageSourceScopeKey", () => {
  it("maps route scopes and degrades unknown ones", () => {
    expect(messageSourceScopeKey("inbox")).toBe("inbox");
    expect(messageSourceScopeKey("activity")).toBe("activity");
    expect(messageSourceScopeKey("comment")).toBe("comment");
    expect(messageSourceScopeKey("run")).toBe("unknown");
  });
});

describe("event label keys", () => {
  it("maps the shared notify inbox catalog", () => {
    const types = [
      "issue_assigned",
      "unassigned",
      "assignee_changed",
      "status_changed",
      "new_comment",
      "mentioned",
      "priority_changed",
      "start_date_changed",
      "due_date_changed",
      "task_completed",
      "task_failed",
      "agent_blocked",
      "agent_completed",
    ] as const;
    for (const type of types) {
      expect(personalEventTypeKey(type)).toBe(type);
    }
    expect(personalEventTypeKey("future_type")).toBeNull();
  });

  it("maps the team-event whitelist", () => {
    expect(teamEventKey("status_changed")).toBe("status_changed");
    expect(teamEventKey("assignee_changed")).toBe("assignee_changed");
    expect(teamEventKey("comment")).toBe("comment");
    expect(teamEventKey("progress_update")).toBeNull();
  });
});

describe("isSourceTargetApproved (exact-scope team consent)", () => {
  const grant = {
    source_kind: "activity",
    project_id: "p1",
    installation_id: "i1",
    target_key: "group:oc_1",
    revoked_at: null as string | null,
  };
  const scope = {
    sourceKind: "activity",
    projectId: "p1",
    installationId: "i1",
    targetKey: "group:oc_1",
  };

  it("matches only the exact (source kind, project range, bot, target) scope", () => {
    expect(isSourceTargetApproved([grant], scope)).toBe(true);
    // A project grant never covers the workspace-wide range, and vice versa.
    expect(isSourceTargetApproved([grant], { ...scope, projectId: null })).toBe(false);
    expect(
      isSourceTargetApproved([{ ...grant, project_id: null }], scope),
    ).toBe(false);
    // activity and comment approvals never cover each other.
    expect(isSourceTargetApproved([grant], { ...scope, sourceKind: "comment" })).toBe(false);
    // Another bot or target is a different grant.
    expect(isSourceTargetApproved([grant], { ...scope, installationId: "i2" })).toBe(false);
    expect(isSourceTargetApproved([grant], { ...scope, targetKey: "group:oc_2" })).toBe(false);
    // A revoked grant no longer applies.
    expect(
      isSourceTargetApproved([{ ...grant, revoked_at: "2026-09-08T00:00:00Z" }], scope),
    ).toBe(false);
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

describe("confirmedRunPages (R3 per-page echo validation)", () => {
  const row = (id: string) => ({ id }) as never;

  it("merges multiple pages whose echoes all match", () => {
    const { rows, unsupported } = confirmedRunPages(
      [
        { applied_run_id: "run-1", deliveries: [row("a"), row("b")] },
        { applied_run_id: "run-1", deliveries: [row("c")] },
      ],
      "run-1",
    );
    expect(unsupported).toBe(false);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects everything when the FIRST page lacks the echo (old server)", () => {
    const { rows, unsupported } = confirmedRunPages(
      [{ applied_run_id: null, deliveries: [row("a")] }],
      "run-1",
    );
    expect(unsupported).toBe(true);
    expect(rows).toEqual([]);
  });

  it("keeps the confirmed prefix and drops a later unconfirmed page", () => {
    const { rows, unsupported } = confirmedRunPages(
      [
        { applied_run_id: "run-1", deliveries: [row("a")] },
        { applied_run_id: null, deliveries: [row("other-run")] },
        { applied_run_id: "run-1", deliveries: [row("c")] },
      ],
      "run-1",
    );
    expect(unsupported).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("treats a mismatched echo as unconfirmed", () => {
    const { rows, unsupported } = confirmedRunPages(
      [{ applied_run_id: "run-2", deliveries: [row("x")] }],
      "run-1",
    );
    expect(unsupported).toBe(true);
    expect(rows).toEqual([]);
  });

  it("empty page list is vacuously confirmed (loading state)", () => {
    const { rows, unsupported } = confirmedRunPages(undefined, "run-1");
    expect(unsupported).toBe(false);
    expect(rows).toEqual([]);
  });
});
