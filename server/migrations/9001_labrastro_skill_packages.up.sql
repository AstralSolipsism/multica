-- Fork-owned tables. Relationships are validated transactionally by handlers.
CREATE TABLE IF NOT EXISTS labrastro_skill_folder (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    parent_id UUID,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    package_id UUID,
    package_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id IS DISTINCT FROM parent_id),
    CHECK ((package_id IS NULL) = (package_path IS NULL))
);
CREATE TABLE IF NOT EXISTS labrastro_skill_package (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    owner_repo TEXT NOT NULL,
    subdirectory TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    root_folder_id UUID NOT NULL,
    created_by UUID NOT NULL,
    candidates JSONB NOT NULL DEFAULT '[]',
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS labrastro_skill_placement (
    workspace_id UUID NOT NULL,
    skill_id UUID NOT NULL,
    folder_id UUID NOT NULL,
    package_id UUID,
    source_path TEXT,
    CHECK ((package_id IS NULL) = (source_path IS NULL))
);
