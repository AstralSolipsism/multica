// ---------------------------------------------------------------------------
// OL-27 source-route surface: personal inbox forwarding ("推送到我的飞书")
// and team event subscriptions. These types mirror
// server/internal/handler/labrastro_message_sources.go and the sqlc rows in
// server/pkg/db/generated/labrastro_message.sql.go — field names and
// nullability follow the wire, not the early design samples.
// ---------------------------------------------------------------------------

import type {
  MessageDeliveryReceipt,
  MessageDeliverySourceKind,
  MessageDeliveryStatus,
  MessageDeliveryTargetSnapshot,
  MessageTargetType,
} from "./message-delivery";

/** Source scopes owned by the OL-27 surface. `run`/automation routes stay on
 * the OL-25 autopilot-scoped API and never appear here. */
export type MessageSourceKind = "inbox" | "activity" | "comment" | string;

/**
 * A personal/team route row. Same stored shape as the automation route plus
 * `source_kind`, `project_id`, `event_types` and `last_disabled_at`;
 * `autopilot_id` is always null (no virtual automation), and this surface has
 * NO `conditions`/`content_mode` — every source record inside the eligibility
 * window is forwarded or explicitly suppressed.
 */
export interface MessageSourceRoute {
  id: string;
  workspace_id: string;
  autopilot_id: string | null;
  source_kind: MessageSourceKind;
  installation_id: string;
  channel_type: string;
  target_type: MessageTargetType;
  /** Inbox routes: the recipient is always the acting member (server-pinned). */
  target_user_id: string | null;
  target_chat_id: string | null;
  target_message_id: string | null;
  target_thread_id: string | null;
  target_key: string;
  /** Team routes only: null = the whole workspace (a distinct consent scope). */
  project_id: string | null;
  /** Decide-time event filter; empty array = every event of the scope. */
  event_types: string[];
  enabled: boolean;
  revision: number;
  created_by: string;
  updated_by: string;
  /** Only source records created at/after this instant are eligible; editing
   * target/project/filter or re-enabling resets it — never a client input. */
  effective_from: string;
  last_disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListMessageSourceRoutesResponse {
  routes: MessageSourceRoute[];
}

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

/** Workspace-admin consent for one team (scope, project range, bot, target).
 * `project_id` null is the explicit workspace-wide grant — never interchangeable
 * with a project grant, and activity/comment approvals never cover each other. */
export interface MessageSourceApprovedTarget {
  id: string;
  workspace_id: string;
  /** Always null for team grants (automation approvals live on OL-25). */
  autopilot_id: string | null;
  source_kind: MessageSourceKind;
  project_id: string | null;
  installation_id: string;
  target_key: string;
  target_type: MessageTargetType;
  approved_by: string;
  approved_at: string;
  /** null while the approval is active. */
  revoked_at: string | null;
}

export interface ListMessageSourceApprovedTargetsResponse {
  approved_targets: MessageSourceApprovedTarget[];
}

export interface ApproveMessageSourceTargetRequest {
  source_kind: MessageSourceKind;
  /** Omit/null = approve the whole workspace explicitly. */
  project_id?: string | null;
  installation_id: string;
  target_type: MessageTargetType;
  target_chat_id: string;
  target_message_id?: string;
}

/** GET /api/message-event-catalog — what the config UI may offer. */
export interface MessageEventCatalogPersonalEvent {
  type: string;
  /** Preference group the event is muted under (see notification settings). */
  group: string;
  /** Stable English gloss; product UI translations live in the locales. */
  label: string;
}

export interface MessageEventCatalogTeamEvent {
  event: string;
  label: string;
}

export interface MessageEventCatalog {
  personal: {
    source_kind: string;
    target_type: string;
    event_types: MessageEventCatalogPersonalEvent[];
  };
  team: {
    source_kind: string;
    events: MessageEventCatalogTeamEvent[];
  }[];
}

/**
 * Records-page row for a source route. Same projection as the automation
 * listing (no snapshots), plus `source_scope` / `source_project_id`; run
 * fields stay null — source records are located by `source_ref_id`.
 */
export interface MessageSourceDelivery {
  id: string;
  workspace_id: string;
  route_id: string;
  route_revision: number;
  autopilot_id: string | null;
  run_id: string | null;
  /** The original persisted source record (inbox_item / activity_log / comment id). */
  source_ref_id: string | null;
  dedup_key?: string;
  source_kind: MessageDeliverySourceKind;
  /** The OL-27 scope this decision came from (inbox/activity/comment); null
   * only for terminal preview test sends whose route was deleted. */
  source_scope: MessageSourceKind | null;
  /** The decision's FROZEN project range. */
  source_project_id: string | null;
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

export interface ListMessageRouteDeliveriesResponse {
  deliveries: MessageSourceDelivery[];
  limit: number;
  offset: number;
}

/** Frozen content for inbox/activity/comment sources (detail endpoint only). */
export interface MessageSourceContentSnapshot {
  text?: string;
  summary?: string;
  source_kind?: string;
  issue_identifier?: string;
  issue_title?: string;
  actor_name?: string;
  /** Human-readable frozen change line, e.g. an assignee transition. */
  change?: string;
  /** Typed assignee transition frozen independently of display names; an
   * unassigned side carries empty strings and renders as Unassigned. */
  assignee_change?: {
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
  };
  body?: string;
  link?: string;
}

/** Source-record locator (detail endpoint only). A locator, never a grant. */
export interface MessageSourceRef {
  source_kind?: MessageSourceKind;
  activity_id?: string;
  comment_id?: string;
  parent_comment_id?: string;
  inbox_item_id?: string;
  issue_id?: string | null;
  issue_identifier?: string | null;
}

export interface GetMessageRouteDeliveryResponse {
  delivery: MessageSourceDelivery;
  content_snapshot: MessageSourceContentSnapshot | null;
  target_snapshot: MessageDeliveryTargetSnapshot | null;
  source_ref: MessageSourceRef | null;
  receipts: MessageDeliveryReceipt[];
}
