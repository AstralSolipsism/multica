import { z } from "zod";

export const MessageRouteSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  autopilot_id: z.string(),
  installation_id: z.string(),
  channel_type: z.string().default("feishu"),
  target_type: z.string(),
  target_user_id: z.string().nullable().default(null),
  target_chat_id: z.string().nullable().default(null),
  target_message_id: z.string().nullable().default(null),
  target_thread_id: z.string().nullable().default(null),
  /** Canonical target identity: member:<uid> / group:<chat_id> /
   * topic:<chat_id>:<message_id>. */
  target_key: z.string().default(""),
  conditions: z.string().default("success"),
  content_mode: z.string().default("summary"),
  enabled: z.boolean().default(false),
  revision: z.number().default(1),
  created_by: z.string().default(""),
  updated_by: z.string().default(""),
  /** Only runs completing at/after this instant are eligible; re-enabling
   * resets it (a disabled window is never backfilled). */
  effective_from: z.string().default(""),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const ListMessageRoutesResponseSchema = z.object({
  routes: z.array(MessageRouteSchema),
}).loose();

export const MessageRouteResponseSchema = z.object({
  route: MessageRouteSchema,
}).loose();

export const MessageApprovedTargetSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  autopilot_id: z.string(),
  installation_id: z.string(),
  target_key: z.string().default(""),
  target_type: z.string(),
  approved_by: z.string().default(""),
  approved_at: z.string().default(""),
  /** null while the approval is active. */
  revoked_at: z.string().nullable().default(null),
}).loose();

export const ListMessageApprovedTargetsResponseSchema = z.object({
  approved_targets: z.array(MessageApprovedTargetSchema),
}).loose();

export const ApproveMessageTargetResponseSchema = z.object({
  approved_target: MessageApprovedTargetSchema,
}).loose();

export const RevokeMessageTargetResponseSchema = z.object({
  revoked: z.boolean().default(false),
  cancelled_deliveries: z.number().default(0),
}).loose();

export const MessageDeliverySchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  route_id: z.string().default(""),
  route_revision: z.number().default(0),
  autopilot_id: z.string().default(""),
  // Test sends carry no source run; the handler serializes the sqlc row's
  // invalid UUID as null, in both list rows and the detail envelope.
  /** Null on manual test sends — they are recorded like deliveries but have
   * no source run (server/internal/messagedelivery/deliveries.go). */
  run_id: z.string().nullable().default(null),
  dedup_key: z.string().optional(),
  source_kind: z.string().default("unknown"),
  // Unknown/future statuses fall through to a generic UI visual; a
  // conservative default would risk presenting an unconfirmed send as
  // delivered, so there is no default here — parse failure falls back to
  // the whole-page fallback instead.
  status: z.string(),
  attempts: z.number().default(0),
  next_attempt_at: z.string().nullable().default(null),
  error_code: z.string().nullable().default(null),
  last_error: z.string().nullable().default(null),
  shard_total: z.number().default(0),
  installation_id: z.string().default(""),
  target_key: z.string().default(""),
  delivered_at: z.string().nullable().default(null),
  first_attempt_at: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
  requested_by: z.string().nullable().optional().default(null),
}).loose();

export const ListMessageDeliveriesResponseSchema = z.object({
  deliveries: z.array(MessageDeliverySchema).default([]),
  limit: z.number().default(0),
  offset: z.number().default(0),
  /** Applied UUID filter; null also covers old/unconfirmed server responses. */
  applied_run_id: z.string().uuid().nullable().catch(null),
}).loose();

export const MessageDeliveryResponseSchema = z.object({
  delivery: MessageDeliverySchema,
}).loose();

export const MessageDeliveryContentSnapshotSchema = z.object({
  text: z.string().optional(),
  summary: z.string().optional(),
  run_status: z.string().optional(),
  has_output: z.boolean().optional(),
  link: z.string().optional(),
}).loose();

export const MessageDeliveryTargetSnapshotSchema = z.object({
  target_type: z.string().optional(),
  channel_type: z.string().optional(),
  installation_id: z.string().optional(),
  user_id: z.string().nullable().optional(),
  open_id: z.string().nullable().optional(),
  chat_id: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
}).loose();

export const MessageDeliverySourceRefSchema = z.object({
  run_id: z.string().optional(),
  execution_mode: z.string().optional(),
  issue_id: z.string().nullable().optional(),
  issue_identifier: z.string().nullable().optional(),
  issue_status: z.string().nullable().optional(),
}).loose();

export const MessageDeliveryReceiptSchema = z.object({
  id: z.string(),
  delivery_id: z.string().default(""),
  workspace_id: z.string().default(""),
  installation_id: z.string().default(""),
  shard_index: z.number().default(0),
  shard_total: z.number().default(1),
  send_uuid: z.string().default(""),
  external_message_id: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const GetMessageDeliveryResponseSchema = z.object({
  delivery: MessageDeliverySchema,
  content_snapshot: MessageDeliveryContentSnapshotSchema.nullable().default(null),
  target_snapshot: MessageDeliveryTargetSnapshotSchema.nullable().default(null),
  source_ref: MessageDeliverySourceRefSchema.nullable().default(null),
  receipts: z.array(MessageDeliveryReceiptSchema).default([]),
}).loose();

export function emptyMessageDeliveryDetail(
  autopilotId: string,
  deliveryId: string,
): GetMessageDeliveryResponse {
  return {
    delivery: {
      id: deliveryId,
      workspace_id: "",
      route_id: "",
      route_revision: 0,
      autopilot_id: autopilotId,
      run_id: null,
      source_kind: "unknown",
      status: "unknown",
      attempts: 0,
      next_attempt_at: null,
      error_code: null,
      last_error: null,
      shard_total: 0,
      installation_id: "",
      target_key: "",
      delivered_at: null,
      first_attempt_at: null,
      created_at: "",
      updated_at: "",
      requested_by: null,
    },
    content_snapshot: null,
    target_snapshot: null,
    source_ref: null,
    receipts: [],
  };
}

export const MessageSourceRouteSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  autopilot_id: z.string().nullable().default(null),
  source_kind: z.string().default("inbox"),
  installation_id: z.string().default(""),
  channel_type: z.string().default("feishu"),
  target_type: z.string(),
  /** Inbox routes: the recipient is always the acting member (server-pinned). */
  target_user_id: z.string().nullable().default(null),
  target_chat_id: z.string().nullable().default(null),
  target_message_id: z.string().nullable().default(null),
  target_thread_id: z.string().nullable().default(null),
  target_key: z.string().default(""),
  /** Team routes only: null = the whole workspace (a distinct consent scope). */
  project_id: z.string().nullable().default(null),
  /** Decide-time event filter; empty array = every event of the scope. */
  event_types: z.array(z.string()).default([]),
  enabled: z.boolean().default(false),
  revision: z.number().default(1),
  created_by: z.string().default(""),
  updated_by: z.string().default(""),
  /** Only source records created at/after this instant are eligible; editing
   * target/project/filter or re-enabling resets it — never a client input. */
  effective_from: z.string().default(""),
  last_disabled_at: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
}).loose();

export const ListMessageSourceRoutesResponseSchema = z.object({
  routes: z.array(MessageSourceRouteSchema),
}).loose();

export const MessageSourceRouteResponseSchema = z.object({
  route: MessageSourceRouteSchema,
}).loose();

export const MessageSourceApprovedTargetSchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  /** Always null for team grants (automation approvals live on OL-25). */
  autopilot_id: z.string().nullable().default(null),
  source_kind: z.string().default("activity"),
  project_id: z.string().nullable().default(null),
  installation_id: z.string().default(""),
  target_key: z.string().default(""),
  target_type: z.string(),
  approved_by: z.string().default(""),
  approved_at: z.string().default(""),
  /** null while the approval is active. */
  revoked_at: z.string().nullable().default(null),
}).loose();

export const ListMessageSourceApprovedTargetsResponseSchema = z.object({
  approved_targets: z.array(MessageSourceApprovedTargetSchema),
}).loose();

export const ApproveMessageSourceTargetResponseSchema = z.object({
  approved_target: MessageSourceApprovedTargetSchema,
}).loose();

export const MessageEventCatalogSchema = z.object({
  personal: z.object({
    source_kind: z.string().default("inbox"),
    target_type: z.string().default("member"),
    event_types: z.array(
      z.object({
        type: z.string(),
        /** Preference group the event is muted under (see notification settings). */
        group: z.string().default(""),
        /** Stable English gloss; product UI translations live in the locales. */
        label: z.string().default(""),
      }).loose(),
    ),
  }).loose(),
  team: z.array(
    z.object({
      source_kind: z.string(),
      events: z.array(
        z.object({
          event: z.string(),
          label: z.string().default(""),
        }).loose(),
      ),
    }).loose(),
  ),
}).loose();

export const MessageSourceDeliverySchema = z.object({
  id: z.string(),
  workspace_id: z.string().default(""),
  route_id: z.string().default(""),
  route_revision: z.number().default(0),
  autopilot_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  /** The original persisted source record (inbox_item / activity_log / comment id). */
  source_ref_id: z.string().nullable().default(null),
  dedup_key: z.string().optional(),
  source_kind: z.string().default("unknown"),
  /** The OL-27 scope this decision came from (inbox/activity/comment); null
   * only for terminal preview test sends whose route was deleted. */
  source_scope: z.string().nullable().default(null),
  /** The decision's FROZEN project range. */
  source_project_id: z.string().nullable().default(null),
  // No conservative default: an unparseable status falls back to the
  // whole-page fallback rather than risk presenting an unconfirmed send.
  status: z.string(),
  attempts: z.number().default(0),
  next_attempt_at: z.string().nullable().default(null),
  error_code: z.string().nullable().default(null),
  last_error: z.string().nullable().default(null),
  shard_total: z.number().default(0),
  installation_id: z.string().default(""),
  target_key: z.string().default(""),
  delivered_at: z.string().nullable().default(null),
  first_attempt_at: z.string().nullable().default(null),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
  requested_by: z.string().nullable().optional().default(null),
}).loose();

export const ListMessageRouteDeliveriesResponseSchema = z.object({
  deliveries: z.array(MessageSourceDeliverySchema).default([]),
  limit: z.number().default(0),
  offset: z.number().default(0),
}).loose();

export const MessageSourceDeliveryResponseSchema = z.object({
  delivery: MessageSourceDeliverySchema,
}).loose();

export const EMPTY_MESSAGE_SOURCE_DELIVERY: MessageSourceDelivery = {
  id: "",
  workspace_id: "",
  route_id: "",
  route_revision: 0,
  autopilot_id: null,
  run_id: null,
  source_ref_id: null,
  source_kind: "unknown",
  source_scope: null,
  source_project_id: null,
  status: "unknown",
  attempts: 0,
  next_attempt_at: null,
  error_code: null,
  last_error: null,
  shard_total: 0,
  installation_id: "",
  target_key: "",
  delivered_at: null,
  first_attempt_at: null,
  created_at: "",
  updated_at: "",
  requested_by: null,
};

export const MessageSourceContentSnapshotSchema = z.object({
  text: z.string().optional(),
  summary: z.string().optional(),
  source_kind: z.string().optional(),
  issue_identifier: z.string().optional(),
  issue_title: z.string().optional(),
  actor_name: z.string().optional(),
  /** Human-readable frozen change line, e.g. an assignee transition. */
  change: z.string().optional(),
  /** Typed assignee transition frozen independently of display names; an
   * unassigned side carries empty strings and renders as Unassigned. */
  assignee_change: z.object({
    from_type: z.string().default(""),
    from_id: z.string().default(""),
    to_type: z.string().default(""),
    to_id: z.string().default(""),
  }).loose().optional(),
  body: z.string().optional(),
  link: z.string().optional(),
}).loose();

export const MessageSourceRefSchema = z.object({
  source_kind: z.string().optional(),
  activity_id: z.string().optional(),
  comment_id: z.string().optional(),
  parent_comment_id: z.string().optional(),
  inbox_item_id: z.string().optional(),
  issue_id: z.string().nullable().optional(),
  issue_identifier: z.string().nullable().optional(),
}).loose();

export const GetMessageRouteDeliveryResponseSchema = z.object({
  delivery: MessageSourceDeliverySchema,
  content_snapshot: MessageSourceContentSnapshotSchema.nullable().default(null),
  target_snapshot: MessageDeliveryTargetSnapshotSchema.nullable().default(null),
  source_ref: MessageSourceRefSchema.nullable().default(null),
  receipts: z.array(MessageDeliveryReceiptSchema).default([]),
}).loose();

export function emptyMessageRouteDeliveryDetail(
  deliveryId: string,
): GetMessageRouteDeliveryResponse {
  return {
    delivery: { ...EMPTY_MESSAGE_SOURCE_DELIVERY, id: deliveryId },
    content_snapshot: null,
    target_snapshot: null,
    source_ref: null,
    receipts: [],
  };
}

export const EMPTY_LIST_MESSAGE_DELIVERIES_RESPONSE: ListMessageDeliveriesResponse = {
  deliveries: [],
  limit: 0,
  offset: 0,
  applied_run_id: null,
};

export const EMPTY_LIST_MESSAGE_ROUTE_DELIVERIES_RESPONSE: ListMessageRouteDeliveriesResponse = {
  deliveries: [],
  limit: 0,
  offset: 0,
};

export type GetMessageDeliveryResponse = z.infer<typeof GetMessageDeliveryResponseSchema>;

/** One message shard's receipt: fixed idempotency UUID plus the platform's
 * external message id (unique per installation). */
export type MessageDeliveryReceipt = z.infer<typeof MessageDeliveryReceiptSchema>;

/** Reserved feedback anchors (detail endpoint only). A locator, never a
 * grant. */
export type MessageDeliverySourceRef = z.infer<typeof MessageDeliverySourceRefSchema>;

/** Frozen resolved target at decision time (detail endpoint only). */
export type MessageDeliveryTargetSnapshot = z.infer<typeof MessageDeliveryTargetSnapshotSchema>;

/** Frozen message content at decision time (detail endpoint only). */
export type MessageDeliveryContentSnapshot = z.infer<typeof MessageDeliveryContentSnapshotSchema>;

export type ListMessageDeliveriesResponse = z.infer<typeof ListMessageDeliveriesResponseSchema>;

/**
 * One delivery record as returned by the records-page endpoint. The list
 * projection deliberately omits content/target snapshots and source_ref.
 * Note `sent` means "the platform accepted every shard" — it never means
 * the recipient has read the message.
 */
export type MessageDelivery = z.infer<typeof MessageDeliverySchema>;

export type RevokeMessageTargetResponse = z.infer<typeof RevokeMessageTargetResponseSchema>;

export type ListMessageApprovedTargetsResponse = z.infer<typeof ListMessageApprovedTargetsResponseSchema>;

/**
 * A workspace-admin consent record for an external group/topic target,
 * scoped to (workspace, automation, installation, target). Member targets
 * never appear here — their binding proves address ownership.
 */
export type MessageApprovedTarget = z.infer<typeof MessageApprovedTargetSchema>;

export type ListMessageRoutesResponse = z.infer<typeof ListMessageRoutesResponseSchema>;

/**
 * A saved push rule: one automation, one bot installation, one target, a
 * condition and a content mode. Writes are revision-guarded — updates and
 * enable/disable must send `expected_revision` or the server answers 409
 * `route_revision_conflict`.
 */
export type MessageRoute = z.infer<typeof MessageRouteSchema>;

/** Route target kinds. `member` DMs a bound member; `group` posts to a chat;
 * `topic` replies to an anchor message in a thread. */
export type MessageTargetType = MessageRoute["target_type"];

/** Which run outcomes a route delivers. */
export type MessageRouteCondition = MessageRoute["conditions"];

/** Digest only, or digest plus the run's final output body. */
export type MessageContentMode = MessageRoute["content_mode"];

/** Delivery lifecycle statuses (labrastro_message_delivery.status). */
export type MessageDeliveryStatus = MessageDelivery["status"];

/** Where the delivered content came from. */
export type MessageDeliverySourceKind = MessageDelivery["source_kind"];

export type GetMessageRouteDeliveryResponse = z.infer<typeof GetMessageRouteDeliveryResponseSchema>;

/** Source-record locator (detail endpoint only). A locator, never a grant. */
export type MessageSourceRef = z.infer<typeof MessageSourceRefSchema>;

/** Frozen content for inbox/activity/comment sources (detail endpoint only). */
export type MessageSourceContentSnapshot = z.infer<typeof MessageSourceContentSnapshotSchema>;

export type ListMessageRouteDeliveriesResponse = z.infer<typeof ListMessageRouteDeliveriesResponseSchema>;

/**
 * Records-page row for a source route. Same projection as the automation
 * listing (no snapshots), plus `source_scope` / `source_project_id`; run
 * fields stay null — source records are located by `source_ref_id`.
 */
export type MessageSourceDelivery = z.infer<typeof MessageSourceDeliverySchema>;

export type MessageEventCatalog = z.infer<typeof MessageEventCatalogSchema>;

export type MessageEventCatalogTeamEvent = MessageEventCatalog["team"][number]["events"][number];

/** GET /api/message-event-catalog — what the config UI may offer. */
export type MessageEventCatalogPersonalEvent = MessageEventCatalog["personal"]["event_types"][number];

export type ListMessageSourceApprovedTargetsResponse = z.infer<typeof ListMessageSourceApprovedTargetsResponseSchema>;

/** Workspace-admin consent for one team (scope, project range, bot, target).
 * `project_id` null is the explicit workspace-wide grant — never interchangeable
 * with a project grant, and activity/comment approvals never cover each other. */
export type MessageSourceApprovedTarget = z.infer<typeof MessageSourceApprovedTargetSchema>;

export type ListMessageSourceRoutesResponse = z.infer<typeof ListMessageSourceRoutesResponseSchema>;

/**
 * A personal/team route row. Same stored shape as the automation route plus
 * `source_kind`, `project_id`, `event_types` and `last_disabled_at`;
 * `autopilot_id` is always null (no virtual automation), and this surface has
 * NO `conditions`/`content_mode` — every source record inside the eligibility
 * window is forwarded or explicitly suppressed.
 */
export type MessageSourceRoute = z.infer<typeof MessageSourceRouteSchema>;

/** Source scopes owned by the OL-27 surface. `run`/automation routes stay on
 * the OL-25 autopilot-scoped API and never appear here. */
export type MessageSourceKind = MessageSourceRoute["source_kind"];
