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

export type { MessageTargetType } from "../api/labrastro-message-delivery-schemas";

export type { MessageRouteCondition } from "../api/labrastro-message-delivery-schemas";

export type { MessageContentMode } from "../api/labrastro-message-delivery-schemas";

export type { MessageDeliveryStatus } from "../api/labrastro-message-delivery-schemas";

export type { MessageDeliverySourceKind } from "../api/labrastro-message-delivery-schemas";

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

export type { MessageApprovedTarget } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageApprovedTargetsResponse } from "../api/labrastro-message-delivery-schemas";

export interface ApproveMessageTargetRequest {
  installation_id: string;
  target_type: MessageTargetType;
  target_chat_id: string;
  target_message_id?: string;
}

export type { RevokeMessageTargetResponse } from "../api/labrastro-message-delivery-schemas";

export type { MessageDelivery } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageDeliveriesResponse } from "../api/labrastro-message-delivery-schemas";

export type { MessageDeliveryContentSnapshot } from "../api/labrastro-message-delivery-schemas";

export type { MessageDeliveryTargetSnapshot } from "../api/labrastro-message-delivery-schemas";

export type { MessageDeliverySourceRef } from "../api/labrastro-message-delivery-schemas";

export type { MessageDeliveryReceipt } from "../api/labrastro-message-delivery-schemas";

export type { GetMessageDeliveryResponse } from "../api/labrastro-message-delivery-schemas";
