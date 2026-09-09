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
  | "delivery_not_found"
  | "delivery_not_retryable"
  | "message_target_admin_required"
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
    case "delivery_not_found":
    case "delivery_not_retryable":
    case "message_target_admin_required":
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
  | "unknown";

export function messageDeliverySourceKindKey(kind: string): MessageDeliverySourceKindKey {
  switch (kind) {
    case "run_only":
    case "create_issue":
    case "test_send":
      return kind;
    default:
      return "unknown";
  }
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
