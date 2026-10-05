import type { MessageSourceKind, MessageTargetType } from "../api/labrastro-message-delivery-schemas";

// ---------------------------------------------------------------------------
// OL-27 source-route surface: personal inbox forwarding ("推送到我的飞书")
// and team event subscriptions. These types mirror
// server/internal/handler/labrastro_message_sources.go and the sqlc rows in
// server/pkg/db/generated/labrastro_message.sql.go — field names and
// nullability follow the wire, not the early design samples.
// ---------------------------------------------------------------------------

export type { MessageSourceKind } from "../api/labrastro-message-delivery-schemas";

export type { MessageSourceRoute } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageSourceRoutesResponse } from "../api/labrastro-message-delivery-schemas";

/** Create/update payload for POST/PUT /api/message-routes. `expected_revision`
 * is required on update and on enable/disable. */
export interface SaveMessageSourceRouteRequest {
  source_kind: MessageSourceKind;
  installation_id: string;
  target_type: MessageTargetType;
  target_user_id?: string;
  target_chat_id?: string;
  target_message_id?: string;
  target_thread_id?: string;
  project_id?: string | null;
  event_types?: string[];
  enabled?: boolean;
  expected_revision?: number;
}

export type { MessageSourceApprovedTarget } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageSourceApprovedTargetsResponse } from "../api/labrastro-message-delivery-schemas";

export interface ApproveMessageSourceTargetRequest {
  source_kind: MessageSourceKind;
  /** Omit/null = approve the whole workspace explicitly. */
  project_id?: string | null;
  installation_id: string;
  target_type: MessageTargetType;
  target_chat_id: string;
  target_message_id?: string;
}

export type { MessageEventCatalogPersonalEvent } from "../api/labrastro-message-delivery-schemas";

export type { MessageEventCatalogTeamEvent } from "../api/labrastro-message-delivery-schemas";

export type { MessageEventCatalog } from "../api/labrastro-message-delivery-schemas";

export type { MessageSourceDelivery } from "../api/labrastro-message-delivery-schemas";

export type { ListMessageRouteDeliveriesResponse } from "../api/labrastro-message-delivery-schemas";

export type { MessageSourceContentSnapshot } from "../api/labrastro-message-delivery-schemas";

export type { MessageSourceRef } from "../api/labrastro-message-delivery-schemas";

export type { GetMessageRouteDeliveryResponse } from "../api/labrastro-message-delivery-schemas";
