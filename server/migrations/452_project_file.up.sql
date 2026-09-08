-- Content objects are immutable. Relationships and cleanup are application-owned.
-- Unique indexes are built in the following single-statement migrations.
CREATE TABLE project_file (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    path text COLLATE "C" NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 1024),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_file_version (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    file_id uuid NOT NULL,
    revision bigint CHECK (revision > 0),
    base_revision bigint NOT NULL CHECK (base_revision >= 0),
    object_key text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content_type text NOT NULL,
    author_type text NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id uuid NOT NULL,
    source_task_id uuid,
    operation_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_file_operation (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('member', 'run')),
    actor_id uuid NOT NULL,
    operation_key text NOT NULL CHECK (octet_length(operation_key) BETWEEN 1 AND 128),
    request jsonb NOT NULL,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK ((result IS NULL) = (completed_at IS NULL))
);

CREATE TABLE project_file_candidate (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    file_id uuid NOT NULL,
    version_id uuid NOT NULL,
    resolved_at timestamptz,
    resolved_by_operation_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((resolved_at IS NULL) = (resolved_by_operation_id IS NULL))
);

-- Each attempt owns a fresh key, including retries of one operation. Pending
-- attempts may already have bytes in storage after a lost upload/commit reply.
-- No attempt is eligible for automatic deletion in this delivery.
CREATE TABLE project_file_upload (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    object_key text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'referenced', 'unreferenced')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
