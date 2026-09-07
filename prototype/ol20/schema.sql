-- OL-20 shared-resource-zone Phase-0 prototype schema.
-- Isolated database (labrastro_filetest); production tables are not touched.
CREATE TABLE IF NOT EXISTS files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL,
  path             text NOT NULL,
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

-- Current-version history: one row per accepted save. op_id is globally
-- unique, making retries idempotent at the database level.
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
  PRIMARY KEY (file_id, revision),
  UNIQUE (op_id)
);

-- Divergent saves: content preserved verbatim, never becomes current on its
-- own. base_revision records what the losing writer thought was current.
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
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (op_id)
);

-- Recorded outcome per operation id: the idempotency ledger. A retry reads
-- the outcome instead of re-applying the write.
CREATE TABLE IF NOT EXISTS op_results (
  op_id    text PRIMARY KEY,
  outcome  text NOT NULL CHECK (outcome IN ('SAVED','CONFLICT')),
  revision bigint,
  note     text NOT NULL DEFAULT ''
);

-- Minimal identity/permission model for the Phase-0 boundary tests.
CREATE TABLE IF NOT EXISTS grants (
  token           text PRIMARY KEY,
  project_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('user','run')),
  run_expires_at  timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
