import type { MessageTargetType, MessageRouteCondition, MessageContentMode } from "../api/labrastro-message-delivery-schemas";

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
export type { MessageTargetType } from "../api/labrastro-message-delivery-schemas";

/** Which run outcomes a route delivers. */
export type { MessageRouteCondition } from "../api/labrastro-message-delivery-schemas";

/** Digest only, or digest plus the run's final output body. */
export type { MessageContentMode } from "../api/labrastro-message-delivery-schemas";

/** Delivery lifecycle statuses (labrastro_message_delivery.status). */
export type { MessageDeliveryStatus } from "../api/labrastro-message-delivery-schemas";

/** Where the delivered content came from. */
export type { MessageDeliverySourceKind } from "../api/labrastro-message-delivery-schemas";

/**
 * A saved push rule: one automation, one bot installation, one target, a
 * condition and a content mode. Writes are revision-guarded — updates and
 * enable/disable must send `expected_revision` or the server answers 409
 * `route_revision_conflict`.
 */
export type { MessageRoute } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageRoutesResponse } from "../api/labrastro-message-delivery-schemas";

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
export type { MessageApprovedTarget } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageApprovedTargetsResponse } from "../api/labrastro-message-delivery-schemas";

export interface ApproveMessageTargetRequest {
  installation_id: string;
  target_type: MessageTargetType;
  target_chat_id: string;
  target_message_id?: string;
}

export type { RevokeMessageTargetResponse } from "../api/labrastro-message-delivery-schemas";

/**
 * One delivery record as returned by the records-page endpoint. The list
 * projection deliberately omits content/target snapshots and source_ref.
 * Note `sent` means "the platform accepted every shard" — it never means
 * the recipient has read the message.
 */
export type { MessageDelivery } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageDeliveriesResponse } from "../api/labrastro-message-delivery-schemas";

/** Frozen message content at decision time (detail endpoint only). */
export type { MessageDeliveryContentSnapshot } from "../api/labrastro-message-delivery-schemas";

/** Frozen resolved target at decision time (detail endpoint only). */
export type { MessageDeliveryTargetSnapshot } from "../api/labrastro-message-delivery-schemas";

/** Reserved feedback anchors (detail endpoint only). A locator, never a
 * grant. */
export type { MessageDeliverySourceRef } from "../api/labrastro-message-delivery-schemas";

/** One message shard's receipt: fixed idempotency UUID plus the platform's
 * external message id (unique per installation). */
export type { MessageDeliveryReceipt } from "../api/labrastro-message-delivery-schemas";

export type { GetMessageDeliveryResponse } from "../api/labrastro-message-delivery-schemas";
