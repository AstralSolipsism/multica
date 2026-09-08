-- OL-25: standalone message-delivery module (Labrastro automation result
-- push to Feishu). Three logical stores, all namespaced with the
-- `labrastro_` prefix so upstream migrations can never collide with them
-- (OL-23 plan, Stage 1):
--
--   labrastro_message_route     saved delivery rule ("结果推送" config)
--   labrastro_message_delivery  one immutable delivery DECISION per
--                              (source event, normalized target), including
--                              decisions NOT to send (suppressed/cancelled),
--                              so the compensator never rescans a source
--   labrastro_message_receipt   per-shard external send ledger with the fixed
--                              send UUID and Lark's message_id
--
-- House rules honored here: NO foreign keys / cascades — every relationship
-- is re-validated in application code (routes re-check the autopilot,
-- installation and member binding before every send; the worker re-checks
-- the parent rows on every claim, so a concurrent delete can at worst cancel
-- a send, never resurrect one). Secondary indexes are separate concurrent
-- migrations (453-458) per the repo migration contract; this file only
-- creates tables and table-level constraints.

-- =====================
-- labrastro_message_route
-- =====================
CREATE TABLE labrastro_message_route (
    id              UUID PRIMARY KEY,
    workspace_id    UUID NOT NULL,
    -- Source scope. Stage 1 of the module (OL-25) only models automation
    -- results: one route targets one autopilot. Personal inbox and team
    -- event sources arrive with a later stage and will widen this column's
    -- meaning via source_kind, not by rewriting this table.
    autopilot_id    UUID NOT NULL,
    -- The bot that performs the send. Not "the most recent binding of the
    -- channel" — the route pins ONE installation so a multi-bot workspace
    -- cannot pick the wrong app (OL-24 §4.2).
    installation_id UUID NOT NULL,
    channel_type    TEXT NOT NULL DEFAULT 'feishu',
    -- Normalized target. member  = a workspace member's bound platform
    --                             identity (re-resolved through
    --                             channel_user_binding at save + send time,
    --                             never guessed from a display name).
    -- group   = an external chat id (chat_id).
    -- topic   = a chat message anchor (chat_id + message_id); the send replies
    --           to that message so the message lands in the 话题.
    target_type     TEXT NOT NULL
        CHECK (target_type IN ('member', 'group', 'topic')),
    target_user_id    UUID,
    target_chat_id    TEXT,
    target_message_id TEXT,
    target_thread_id  TEXT,
    -- Canonical target identity used for uniqueness and cross-route
    -- deduplication. Two routes whose normalized targets are equal can only
    -- produce one delivery decision per source event.
    target_key      TEXT NOT NULL,
    -- Which run outcomes this route delivers: 'success' = completed runs,
    -- 'failure' = failed runs, 'all' = both. Skipped runs never match a
    -- condition; the enqueue step records a suppressed decision for them.
    conditions      TEXT NOT NULL DEFAULT 'success'
        CHECK (conditions IN ('success', 'failure', 'all')),
    -- 'summary' sends the digest (status + source link);
    -- 'with_output' additionally includes the run's final output for
    -- run_only sources. Raw task results (work dirs, session ids, provider
    -- payloads) are never included on either mode.
    content_mode    TEXT NOT NULL DEFAULT 'summary'
        CHECK (content_mode IN ('summary', 'with_output')),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    -- Optimistic-concurrency token: every edit bumps the revision and a
    -- stale client is refused instead of silently overwriting.
    revision        INTEGER NOT NULL DEFAULT 1
        CHECK (revision >= 1),
    created_by      UUID NOT NULL,
    updated_by      UUID NOT NULL,
    -- Runs completing BEFORE effective_from are never delivered by this
    -- route. Set at creation and reset on every enable, which implements
    -- "only results produced after enabling" and "re-enabling does not
    -- backfill the disabled window".
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One target shape per target_type, enforced in the row so a half-saved
    -- target can never enter the delivery pipeline.
    CONSTRAINT labrastro_message_route_target_shape CHECK (
        (target_type = 'member'
            AND target_user_id IS NOT NULL
            AND target_chat_id IS NULL
            AND target_message_id IS NULL)
     OR (target_type = 'group'
            AND target_chat_id IS NOT NULL
            AND target_user_id IS NULL
            AND target_message_id IS NULL)
     OR (target_type = 'topic'
            AND target_chat_id IS NOT NULL
            AND target_message_id IS NOT NULL
            AND target_user_id IS NULL)
    )
);

-- =====================
-- labrastro_message_delivery
-- =====================
CREATE TABLE labrastro_message_delivery (
    id              UUID PRIMARY KEY,
    workspace_id    UUID NOT NULL,
    -- The rule that produced this decision. NULL for test sends. The route
    -- may be deleted later; the snapshots below keep the decision
    -- self-describing, so nothing joins back to reconstruct history.
    route_id        UUID,
    route_revision  INTEGER,
    autopilot_id    UUID NOT NULL,
    -- The source event (autopilot_run.id). NULL only for test sends.
    run_id          UUID,
    -- Stable decision identity: run:<run_id>:<installation_id>:<target_key>
    -- (test:<uuid> for test sends). UNIQUE index in migration 454 makes
    -- "same source, same target" produce exactly ONE decision across
    -- concurrent enqueuers and equivalent routes.
    dedup_key       TEXT NOT NULL,
    source_kind     TEXT NOT NULL
        CHECK (source_kind IN ('run_only', 'create_issue', 'test_send')),
    -- queued    waiting to send
    -- sending   lease held, HTTP call in flight (crash here resolves to
    --           uncertain, never straight back to queued)
    -- sent      external platform accepted every shard, receipts recorded
    -- failed    definitive failure (invalid target, revoked bot, exhausted
    --           attempts) — explainable via error_code
    -- uncertain the send MAY have reached the platform (lost response or
    --           lost receipt); only manual verify-and-retry resolves it
    -- cancelled route disabled/deleted, source archived, or installation
    --           revoked before the send started
    -- suppressed condition mismatch / nothing publishable — recorded so the
    --           compensator does not rescan the source forever
    status          TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'sending', 'sent', 'failed',
                          'uncertain', 'cancelled', 'suppressed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token     UUID,
    lease_expires_at TIMESTAMPTZ,
    error_code      TEXT,
    last_error      TEXT,
    -- Frozen at decision time: the rendered message body. Edits to the rule
    -- never rewrite an enqueued message; the shards are a pure function of
    -- this snapshot, so retries cannot re-split the text.
    content_snapshot JSONB NOT NULL,
    -- Frozen at decision time: installation, target addresses and the
    -- open_id seen when the decision was made. The send path re-resolves
    -- the LIVE binding and installation state before dialing; the snapshot
    -- only records what the decision was based on.
    target_snapshot JSONB NOT NULL,
    -- installation_id + target_key mirror the dedup identity as plain
    -- columns so the compensator's "does this source already have a
    -- decision for this target" check is a plain indexed lookup rather
    -- than a JSONB probe. Read-only copies: edits to a route never rewrite
    -- them.
    installation_id UUID NOT NULL,
    target_key      TEXT NOT NULL,
    -- Number of shards the frozen content splits into. Fixed at enqueue.
    shard_total     INTEGER NOT NULL DEFAULT 1
        CHECK (shard_total >= 1),
    -- Feedback anchors for the later feedback stage: issue id, delivery
    -- anchor comment reference, run link. A reference LOCATES the source;
    -- it never grants permission by itself.
    source_ref      JSONB,
    delivered_at    TIMESTAMPTZ,
    first_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns duplicated from target_snapshot (installation + normalized target)
-- so the compensator's "does this source already have a decision for this
-- target" check is a plain indexed lookup instead of a JSONB probe.
-- No FK by house rule; the worker re-validates both ids on every claim.

-- =====================
-- labrastro_message_receipt
-- =====================
CREATE TABLE labrastro_message_receipt (
    -- Receipts are system-generated, so the id defaults server-side
    -- (unlike routes/deliveries, whose ids come from the application).
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id     UUID NOT NULL,
    workspace_id    UUID NOT NULL,
    installation_id UUID NOT NULL,
    -- Stable shard identity: (delivery_id, shard_index) is the unique pair,
    -- so a retry cannot re-split or renumber shards. send_uuid is fixed per
    -- shard for Lark's idempotent-send window; a retry reuses the SAME uuid.
    shard_index     INTEGER NOT NULL
        CHECK (shard_index >= 0),
    shard_total     INTEGER NOT NULL
        CHECK (shard_total >= 1),
    send_uuid       TEXT NOT NULL,
    -- The platform's message id, recorded for EVERY accepted send. Unique
    -- per installation (migration 458) so an inbound reply can trace back
    -- to the originating delivery in the feedback stage.
    external_message_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
