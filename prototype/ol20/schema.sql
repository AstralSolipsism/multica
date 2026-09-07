-- OL-20 shared-resource-zone Phase-0 prototype schema (v2, post-review).
-- Idempotency ledger is scoped to (project, actor, op_id) and stores the
-- full request binding: target path, base revision, content digest, and the
-- complete outcome including conflict details. Grants carry the authoritative
-- actor identity; saves never trust client-supplied authors.
CREATE TABLE IF NOT EXISTS files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL,
  path             text NOT NULL,
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS revisions (
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision    bigint NOT NULL CHECK (revision > 0),
  content_key text NOT NULL,
  size        bigint NOT NULL,
  sha256      text NOT NULL,
  author_kind text NOT NULL,
  author_id   text NOT NULL,
  op_id       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, revision)
);

-- Conflict content keys are random UUIDs: two racing writers reusing one
-- operation id must never be able to overwrite referenced candidate content.
CREATE TABLE IF NOT EXISTS conflict_candidates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id        uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  base_revision  bigint NOT NULL,
  content_key    text NOT NULL,
  size           bigint NOT NULL,
  sha256         text NOT NULL,
  author_kind    text NOT NULL,
  author_id      text NOT NULL,
  op_id          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotency ledger, scoped and request-bound (review P1-1). A hit replays
-- only when every bound field matches; any mismatch is an explicit error.
CREATE TABLE IF NOT EXISTS op_results (
  project_id       uuid NOT NULL,
  actor_id         text NOT NULL,
  op_id            text NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('SAVED','CONFLICT')),
  revision         bigint,          -- SAVED: the new current revision
  candidate_id     uuid,            -- CONFLICT: preserved candidate
  conflict_current bigint,          -- CONFLICT: current revision at the time
  path             text NOT NULL,
  base_revision    bigint NOT NULL,
  content_sha256   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_id, op_id)
);

-- Identity model (review P1-2): grants carry the authoritative actor.
CREATE TABLE IF NOT EXISTS grants (
  token           text PRIMARY KEY,
  project_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('user','run')),
  actor_id        text NOT NULL,
  run_expires_at  timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
