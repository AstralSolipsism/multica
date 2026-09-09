/**
 * Labrastro message-delivery types (OL-25 backend, OL-26 frontend).
 *
 * Wire shapes mirror `server/internal/messagedelivery` /
 * `server/internal/handler/labrastro_message_delivery.go`. The backend
 * README (`server/internal/messagedelivery/README.md`) is the authoritative
 * contract — field names, statuses and error codes must not be guessed.
 *
 * Compatibility: enums stay `| string` unions so a future server-side value
 * degrades to a generic UI fallback; additive fields must be optional (see
 * CLAUDE.md → API Response Compatibility).
 */

/** Route target kinds. `member` DMs a bound member; `group` posts to a chat;
 * `topic` replies to an anchor message in a thread. */
export type MessageTargetType = "member" | "group" | "topic" | string;

/** Which run outcomes a route delivers. */
export type MessageRouteCondition = "success" | "failure" | "all" | string;

/** Digest only, or digest plus the run's final output body. */
export type MessageContentMode = "summary" | "with_output" | string;

/** Delivery lifecycle statuses (labrastro_message_delivery.status). */
export type MessageDeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "suppressed"
  | string;

/** Where the delivered content came from. */
export type MessageDeliverySourceKind =
  | "run_only"
  | "create_issue"
  | "test_send"
  | "unknown"
  | string;

/**
 * A saved push rule: one automation, one bot installation, one target, a
 * condition and a content mode. Writes are revision-guarded — updates and
 * enable/disable must send `expected_revision` or the server answers 409
 * `route_revision_conflict`.
 */
export interface MessageRoute {
  id: string;
  workspace_id: string;
  autopilot_id: string;
  installation_id: string;
  channel_type: string;
  target_type: MessageTargetType;
  target_user_id: string | null;
  target_chat_id: string | null;
  target_message_id: string | null;
  target_thread_id: string | null;
  /** Canonical target identity: member:<uid> / group:<chat_id> /
   * topic:<chat_id>:<message_id>. */
  target_key: string;
  conditions: MessageRouteCondition;
  content_mode: MessageContentMode;
  enabled: boolean;
  revision: number;
  created_by: string;
  updated_by: string;
  /** Only runs completing at/after this instant are eligible; re-enabling
   * resets it (a disabled window is never backfilled). */
  effective_from: string;
  created_at: string;
  updated_at: string;
}

export interface ListMessageRoutesResponse {
  routes: MessageRoute[];
}

/** Create/update payload. `expected_revision` gates updates and
 * enable/disable; create ignores it. */
export interface SaveMessageRouteRequest {
  installation_id: string;
  target_type: MessageTargetType;
  target_user_id?: string;
  target_chat_id?: string;
  target_message_id?: string;
  target_thread_id?: string;
  conditions: MessageRouteCondition;
  content_mode: MessageContentMode;
  enabled?: boolean;
  expected_revision?: number;
}

/**
 * A workspace-admin consent record for an external group/topic target,
 * scoped to (workspace, automation, installation, target). Member targets
 * never appear here — their binding proves address ownership.
 */
export interface MessageApprovedTarget {
  id: string;
  workspace_id: string;
  autopilot_id: string;
  installation_id: string;
  target_key: string;
  target_type: MessageTargetType;
  approved_by: string;
  approved_at: string;
  /** null while the approval is active. */
  revoked_at: string | null;
}

export interface ListMessageApprovedTargetsResponse {
  approved_targets: MessageApprovedTarget[];
}

export interface ApproveMessageTargetRequest {
  installation_id: string;
  target_type: MessageTargetType;
  target_chat_id: string;
  target_message_id?: string;
}

export interface RevokeMessageTargetResponse {
  revoked: boolean;
  cancelled_deliveries: number;
}

/**
 * One delivery record as returned by the records-page endpoint. The list
 * projection deliberately omits content/target snapshots and source_ref.
 * Note `sent` means "the platform accepted every shard" — it never means
 * the recipient has read the message.
 */
export interface MessageDelivery {
  id: string;
  workspace_id: string;
  route_id: string;
  route_revision: number;
  autopilot_id: string;
  /** Null on manual test sends — they are recorded like deliveries but have
   * no source run (server/internal/messagedelivery/deliveries.go). */
  run_id: string | null;
  dedup_key?: string;
  source_kind: MessageDeliverySourceKind;
  status: MessageDeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  last_error: string | null;
  shard_total: number;
  installation_id: string;
  target_key: string;
  delivered_at: string | null;
  first_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  requested_by?: string | null;
}

export interface ListMessageDeliveriesResponse {
  deliveries: MessageDelivery[];
  limit: number;
  offset: number;
}

/** Frozen message content at decision time (detail endpoint only). */
export interface MessageDeliveryContentSnapshot {
  text?: string;
  summary?: string;
  run_status?: string;
  has_output?: boolean;
  link?: string;
}

/** Frozen resolved target at decision time (detail endpoint only). */
export interface MessageDeliveryTargetSnapshot {
  target_type?: MessageTargetType;
  channel_type?: string;
  installation_id?: string;
  user_id?: string | null;
  open_id?: string | null;
  chat_id?: string | null;
  message_id?: string | null;
  thread_id?: string | null;
}

/** Reserved feedback anchors (detail endpoint only). A locator, never a
 * grant. */
export interface MessageDeliverySourceRef {
  run_id?: string;
  execution_mode?: string;
  issue_id?: string | null;
  issue_identifier?: string | null;
  issue_status?: string | null;
}

/** One message shard's receipt: fixed idempotency UUID plus the platform's
 * external message id (unique per installation). */
export interface MessageDeliveryReceipt {
  id: string;
  delivery_id: string;
  workspace_id: string;
  installation_id: string;
  shard_index: number;
  shard_total: number;
  send_uuid: string;
  external_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GetMessageDeliveryResponse {
  delivery: MessageDelivery;
  content_snapshot: MessageDeliveryContentSnapshot | null;
  target_snapshot: MessageDeliveryTargetSnapshot | null;
  source_ref: MessageDeliverySourceRef | null;
  receipts: MessageDeliveryReceipt[];
}
