import type {
  ListMessageDeliveriesResponse,
  MessageDelivery,
} from "@multica/core/types";

// Pure copy/classification helpers for the message-delivery surface (OL-26).
// Keys mirror the stable wire codes in server/internal/messagedelivery — the
// switch form keeps the mapping exhaustive at compile time; unknown/future
// codes degrade to generic copy instead of leaking a raw server sentence.

/** HTTP/API error codes → keys under the `error` map. */
export type MessageDeliveryErrorKey =
  | "route_invalid"
  | "route_installation_invalid"
  | "route_member_not_bound"
  | "route_target_not_member"
  | "route_target_not_approved"
  | "route_target_unverifiable"
  | "route_target_unreachable"
  | "route_topic_anchor_mismatch"
  | "route_not_found"
  | "route_revision_conflict"
  | "route_already_exists"
  | "route_disabled"
  | "route_not_self"
  | "delivery_not_found"
  | "delivery_not_retryable"
  | "message_target_admin_required"
  | "message_no_originator"
  | "message_forbidden"
  | "authorization_lost"
  | "source_unavailable"
  | "autopilot_no_originator"
  | "autopilot_forbidden"
  | "response_unconfirmed"
  | "generic";

export function messageDeliveryErrorKey(code: string | undefined): MessageDeliveryErrorKey {
  switch (code) {
    case "route_invalid":
    case "route_installation_invalid":
    case "route_member_not_bound":
    case "route_target_not_member":
    case "route_target_not_approved":
    case "route_target_unverifiable":
    case "route_target_unreachable":
    case "route_topic_anchor_mismatch":
    case "route_not_found":
    case "route_revision_conflict":
    case "route_already_exists":
    case "route_disabled":
    case "route_not_self":
    case "delivery_not_found":
    case "delivery_not_retryable":
    case "message_target_admin_required":
    case "message_no_originator":
    case "message_forbidden":
    case "authorization_lost":
    case "source_unavailable":
    case "autopilot_no_originator":
    case "autopilot_forbidden":
    case "response_unconfirmed":
      return code;
    default:
      return "generic";
  }
}

/** Delivery row `error_code` values → keys under the `error_code` map. */
export type MessageDeliveryErrorCodeKey =
  | "route_disabled"
  | "route_deleted"
  | "source_archived"
  | "source_missing"
  | "condition_mismatch"
  | "recipient_muted"
  | "member_unbound"
  | "installation_revoked"
  | "installation_missing"
  | "send_rejected"
  | "send_transient"
  | "sender_unavailable"
  | "attempts_exhausted"
  | "lease_expired"
  | "send_ambiguous"
  | "route_target_unverifiable"
  | "route_target_unreachable"
  | "route_topic_anchor_mismatch"
  | "route_authorization_lost"
  | "route_target_not_approved"
  | "source_unresolved"
  | "unknown";

export function messageDeliveryErrorCodeKey(code: string | null | undefined): MessageDeliveryErrorCodeKey {
  switch (code) {
    case "route_disabled":
    case "route_deleted":
    case "source_archived":
    case "source_missing":
    case "condition_mismatch":
    case "recipient_muted":
    case "member_unbound":
    case "installation_revoked":
    case "installation_missing":
    case "send_rejected":
    case "send_transient":
    case "sender_unavailable":
    case "attempts_exhausted":
    case "lease_expired":
    case "send_ambiguous":
    case "route_target_unverifiable":
    case "route_target_unreachable":
    case "route_topic_anchor_mismatch":
    case "route_authorization_lost":
    case "route_target_not_approved":
    case "source_unresolved":
      return code;
    default:
      return "unknown";
  }
}

/** Delivery lifecycle statuses → keys under `deliveries.status`. Unknown
 * server-side values degrade to the generic "unknown" visual + label. */
export type MessageDeliveryStatusKey =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "suppressed"
  | "unknown";

export function messageDeliveryStatusKey(status: string): MessageDeliveryStatusKey {
  switch (status) {
    case "queued":
    case "sending":
    case "sent":
    case "failed":
    case "uncertain":
    case "cancelled":
    case "suppressed":
      return status;
    default:
      return "unknown";
  }
}

export type MessageDeliverySourceKindKey =
  | "run_only"
  | "create_issue"
  | "test_send"
  | "inbox"
  | "activity"
  | "comment"
  | "unknown";

export function messageDeliverySourceKindKey(kind: string): MessageDeliverySourceKindKey {
  switch (kind) {
    case "run_only":
    case "create_issue":
    case "test_send":
      return kind;
    // OL-27 source scopes appear as the delivery's source_kind on the
    // personal/team records surface.
    case "inbox":
    case "activity":
    case "comment":
      return kind;
    default:
      return "unknown";
  }
}

/** Route source scopes (OL-27) → keys under `source.kind`. */
export type MessageSourceScopeKey = "inbox" | "activity" | "comment" | "unknown";

export function messageSourceScopeKey(kind: string): MessageSourceScopeKey {
  switch (kind) {
    case "inbox":
    case "activity":
    case "comment":
      return kind;
    default:
      return "unknown";
  }
}

/**
 * Personal-route event types (the shared notify inbox catalog) → keys under
 * `event`. Returns null for a type the UI has no translation for — callers
 * fall back to the server-provided English label rather than dropping the
 * option.
 */
export type PersonalEventTypeKey =
  | "issue_assigned"
  | "unassigned"
  | "assignee_changed"
  | "status_changed"
  | "new_comment"
  | "mentioned"
  | "priority_changed"
  | "start_date_changed"
  | "due_date_changed"
  | "task_completed"
  | "task_failed"
  | "agent_blocked"
  | "agent_completed";

export function personalEventTypeKey(type: string): PersonalEventTypeKey | null {
  switch (type) {
    case "issue_assigned":
    case "unassigned":
    case "assignee_changed":
    case "status_changed":
    case "new_comment":
    case "mentioned":
    case "priority_changed":
    case "start_date_changed":
    case "due_date_changed":
    case "task_completed":
    case "task_failed":
    case "agent_blocked":
    case "agent_completed":
      return type;
    default:
      return null;
  }
}

/** Team-route events → keys under `team_event`; null → use the server label. */
export type TeamEventKey = "status_changed" | "assignee_changed" | "comment";

export function teamEventKey(event: string): TeamEventKey | null {
  switch (event) {
    case "status_changed":
    case "assignee_changed":
    case "comment":
      return event;
    default:
      return null;
  }
}

/**
 * Exact team-approval match. An approval covers only its precise
 * (source_kind, project range, installation, target) scope: a project grant
 * never covers the workspace range (project_id null), activity never covers
 * comment, and an automation's approval is never borrowed. Changing any
 * dimension must stop showing the old approval as applicable.
 */
export function isSourceTargetApproved(
  approvals: ReadonlyArray<{
    source_kind: string;
    project_id: string | null;
    installation_id: string;
    target_key: string;
    revoked_at: string | null;
  }>,
  scope: {
    sourceKind: string;
    projectId: string | null;
    installationId: string;
    targetKey: string;
  },
): boolean {
  return approvals.some(
    (a) =>
      a.source_kind === scope.sourceKind &&
      a.project_id === scope.projectId &&
      a.installation_id === scope.installationId &&
      a.target_key === scope.targetKey &&
      a.revoked_at == null,
  );
}

/** The server only allows retrying `failed` (cause fixed) and `uncertain`
 * (operator verified) deliveries; everything else is a 409
 * delivery_not_retryable. The UI mirrors that rule to save the round-trip. */
export function canRetryMessageDelivery(status: string): boolean {
  return status === "failed" || status === "uncertain";
}

/**
 * Canonical target identity, mirroring server TargetKey. Used to match a
 * typed target against the approved-targets list so the editor can tell an
 * admin whether saving will approve first. Topic keys use the user-entered
 * ids; the server stores the VERIFIED chat id, so a mistyped topic simply
 * won't match and will be verified again at approve/save time.
 */
export function messageTargetKey(
  targetType: string,
  ids: { userId?: string; chatId?: string; messageId?: string },
): string {
  switch (targetType) {
    case "member":
      return `member:${ids.userId ?? ""}`;
    case "group":
      return `group:${ids.chatId ?? ""}`;
    case "topic":
      return `topic:${ids.chatId ?? ""}:${ids.messageId ?? ""}`;
    default:
      return `${targetType}:unknown`;
  }
}

/**
 * R3 shared echo validation: every consumed page of a run-scoped records
 * query must echo the requested run_id, otherwise the server ignored the
 * filter (pre-contract server) and the page must NOT be merged into this
 * run's view. All consumers (run badges, the per-run list dialog, polling
 * refetches) go through this single judgment.
 *
 * Pages are processed in order; the first unconfirmed page ends the merge,
 * so rows from a valid prefix stay visible and everything past it is
 * excluded.
 */
export function confirmedRunPages(
  pages:
    | ReadonlyArray<
        Pick<ListMessageDeliveriesResponse, "applied_run_id" | "deliveries">
      >
    | undefined,
  runId: string,
): { rows: MessageDelivery[]; unsupported: boolean } {
  const rows: MessageDelivery[] = [];
  for (const page of pages ?? []) {
    if (page.applied_run_id !== runId) {
      return { rows, unsupported: true };
    }
    rows.push(...page.deliveries);
  }
  return { rows, unsupported: false };
}
