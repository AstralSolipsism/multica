package main

import (
	"context"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

var baselineWikiLegacyVersions = []string{
	"9039_labrastro_engineering_tables",
	"9040_labrastro_engineering_config_identity_index",
	"9041_labrastro_engineering_doc_identity_index",
	"9042_labrastro_engineering_doc_chapter_index",
	"9043_labrastro_engineering_revision_identity_index",
	"9044_labrastro_engineering_revision_number_index",
	"9045_labrastro_engineering_candidate_index",
	"9046_labrastro_engineering_decisions",
	"9047_labrastro_engineering_stages",
	"9048_labrastro_baseline_module_chapters",
	"9049_labrastro_quota_source_tables",
	"9050_labrastro_quota_source_id_index",
	"9051_labrastro_quota_source_owner_index",
	"9052_labrastro_quota_source_due_index",
	"9053_labrastro_quota_source_zenmux_cleanup",
	"9054_labrastro_default_workflow_keep_in_use_statuses",
	"9059_labrastro_baseline_annotations",
	"9060_labrastro_baseline_review_client_key_index",
	"9061_labrastro_baseline_annotation_active_index",
	"9062_labrastro_baseline_annotation_ordinal_index",
	"9063_labrastro_baseline_review_batch_index",
	"9064_labrastro_baseline_text_block_lines",
	"9065_labrastro_message_delivery_route_listing_index",
	"9066_labrastro_retire_conversation_provenance",
}

var baselineWikiVersions = []string{
	"9067_labrastro_baseline_wiki_pages",
	"9068_labrastro_baseline_page_slug_index",
	"9069_labrastro_baseline_revision_page_index",
	"9070_labrastro_baseline_revision_activity_index",
}

// baselineWikiStubTables creates minimal local stand-ins for the unrelated
// upstream tables migrations 9053/9054/9065/9066 touch, so the whole fork
// chain can run inside one throwaway schema.
func baselineWikiStubTables(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, statement := range []string{
		`CREATE TABLE agent_runtime (plan_quota jsonb)`,
		`CREATE TABLE issue_workflow (id uuid, workspace_id uuid, is_default boolean, steps jsonb, updated_at timestamptz)`,
		`CREATE TABLE issue_status (workspace_id uuid, key text, position int, is_system boolean, archived_at timestamptz)`,
		`CREATE TABLE issue (workspace_id uuid, status text, project_id uuid)`,
		`CREATE TABLE project (id uuid, workspace_id uuid, workflow_id uuid)`,
		`CREATE TABLE labrastro_message_delivery (workspace_id uuid, route_id uuid, created_at timestamptz, id uuid, autopilot_id uuid)`,
		`CREATE TABLE channel_installation (channel_type text, config jsonb, updated_at timestamptz)`,
		`CREATE TABLE agent_task_queue (id uuid, status text, completed_at timestamptz, prepare_lease_expires_at timestamptz,
			cancelled_by_type text, cancelled_by_id uuid, cancelled_by_name text, conversation_root_task_id uuid,
			originator_source text, delegated_from_task_id uuid)`,
		`CREATE TABLE task_token (task_id uuid)`,
		`CREATE TABLE comment (source_task_id uuid, author_type text, type text, recovery_settled_at timestamptz)`,
		`CREATE TABLE issue_wakeup (id uuid, issue_id uuid, workspace_id uuid, enabled boolean, kind text,
			event_types text[], filter_actor_type text, filter_actor_id uuid, filter_agent_id uuid,
			filter_task_id uuid, source_task_id uuid)`,
		`CREATE TABLE issue_wakeup_receipt (id uuid, wakeup_id uuid, revision bigint, event_key text, event_type text,
			payload jsonb, coalesce_key text, processed_at timestamptz)`,
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("create stub table: %v\n%s", err, statement)
		}
	}
}

func baselineWikiColumnExists(t *testing.T, pool *pgxpool.Pool, schema, table, column string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(context.Background(), `
		SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema=$1 AND table_name=$2 AND column_name=$3)`, schema, table, column).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}

func baselineWikiColumnNotNull(t *testing.T, pool *pgxpool.Pool, schema, table, column string) {
	t.Helper()
	var nullable string
	if err := pool.QueryRow(context.Background(), `
		SELECT is_nullable FROM information_schema.columns
		WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`, schema, table, column).Scan(&nullable); err != nil {
		t.Fatalf("column %s.%s missing: %v", table, column, err)
	}
	if nullable != "NO" {
		t.Fatalf("%s.%s is nullable", table, column)
	}
}

func baselineWikiConstraintDef(t *testing.T, pool *pgxpool.Pool, schema, table, constraint string) string {
	t.Helper()
	var definition string
	if err := pool.QueryRow(context.Background(), `
		SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conrelid = $1::regclass AND conname = $2`,
		`"`+schema+`"."`+table+`"`, constraint).Scan(&definition); err != nil {
		t.Fatalf("constraint %s on %s missing: %v", constraint, table, err)
	}
	return definition
}

func baselineWikiCheckRejects(t *testing.T, pool *pgxpool.Pool, statement string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), statement); err == nil {
		t.Fatalf("check accepted invalid row: %s", statement)
	}
}

func TestLabrastroBaselineWikiMigrations(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	schema := "baseline_wiki_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		tables := []string{
			"project_baseline_revision", "project_baseline_page", "project_baseline_doc",
			"project_baseline_annotation", "project_baseline_review", "project_baseline_annotation_batch",
			"project_engineering", "quota_source",
			"agent_runtime", "issue_workflow", "issue_status", "issue", "project",
			"labrastro_message_delivery", "channel_installation", "agent_task_queue", "task_token",
			"comment", "issue_wakeup", "issue_wakeup_receipt", "schema_migrations",
		}
		for _, table := range tables {
			if _, err := admin.Exec(context.Background(), "DROP TABLE IF EXISTS "+quoted+"."+table+" CASCADE"); err != nil {
				t.Error(err)
			}
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	baselineWikiStubTables(t, ctx, pool)

	run := func(direction string, versions []string) {
		t.Helper()
		opts := runOptions{
			Direction: direction, Files: realMigrationFiles(t, versions, direction),
			SchemaMigrationsTable: schema + ".schema_migrations",
			AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
			Hooks:                 hooksForDirection(direction),
		}
		if err := runMigrations(ctx, pool, opts); err != nil {
			t.Fatalf("migrate %s %v: %v", direction, versions, err)
		}
	}

	// Fresh install through 9066, then legacy rows in the OLD shapes.
	run("up", baselineWikiLegacyVersions)
	const wsID, projectID = "'00000000-0000-0000-0000-000000000001'", "'00000000-0000-0000-0000-000000000002'"
	for _, chapter := range []string{"overview", "domain_rules", "architecture", "exclusions_and_risks", "module:payments"} {
		if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_doc
			(workspace_id, project_id, chapter, title, position, adopted_revision_id, candidate_revision_id)
			VALUES (`+wsID+`, `+projectID+`, '`+chapter+`', '旧标题', 0, NULL, NULL)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_revision
			(workspace_id, project_id, chapter, revision_number, status, content_markdown, change_summary, anchors_diff,
			 created_by_type, created_by_id, decided_by_type, decided_by_id, decided_at, decision_credential)
			VALUES (`+wsID+`, `+projectID+`, '`+chapter+`', 1, 'adopted', '# 已生效', '采纳', '{}'::jsonb,
			 'member', gen_random_uuid(), 'member', gen_random_uuid(), now(), 'session'),
			       (`+wsID+`, `+projectID+`, '`+chapter+`', 2, 'candidate', '# 待审', '候选', '{}'::jsonb,
			 'agent', gen_random_uuid(), NULL, NULL, NULL, NULL)`); err != nil {
			t.Fatal(err)
		}
	}
	// Annotation batch with one review, one responded ('' response), one
	// unresponded (NULL), and one resolved annotation.
	if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_annotation_batch
		(workspace_id, project_id, chapter, carrier_kind, issue_id, agent_id, created_by_type, created_by_id)
		VALUES (`+wsID+`, `+projectID+`, 'overview', 'revision_issue', NULL, gen_random_uuid(), 'member', gen_random_uuid())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_review
		(workspace_id, project_id, batch_id, client_key, reviewed_revision_id, summary, created_by_type, created_by_id)
		SELECT `+wsID+`, `+projectID+`, id, gen_random_uuid(),
			(SELECT r.id FROM project_baseline_revision r WHERE r.revision_number = 1 LIMIT 1),
			'评审', 'member', gen_random_uuid()
		FROM project_baseline_annotation_batch`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_annotation
		(workspace_id, project_id, batch_id, review_id, ordinal, anchor_kind, target_revision_id, target_revision_number,
		 section_anchor, note, response, responded_at, resolved_at, resolved_by_type, resolved_by_id, created_by_type, created_by_id)
		SELECT `+wsID+`, `+projectID+`, b.id, v.id, n, 'section',
			(SELECT r.id FROM project_baseline_revision r ORDER BY r.created_at LIMIT 1), 1,
			'anchor-1', '批注' || n,
			CASE WHEN n = 1 THEN '' ELSE NULL END,
			CASE WHEN n = 1 THEN now() ELSE NULL END,
			CASE WHEN n = 3 THEN now() END,
			CASE WHEN n = 3 THEN 'member' END,
			CASE WHEN n = 3 THEN gen_random_uuid() END,
			'member', gen_random_uuid()
		FROM project_baseline_annotation_batch b
		CROSS JOIN project_baseline_review v
		CROSS JOIN generate_series(1, 3) AS n`); err != nil {
		t.Fatal(err)
	}

	// Upgrade to the wiki schema: legacy data is wiped, annotations dropped.
	run("up", baselineWikiVersions)
	for _, table := range []string{"project_baseline_page", "project_baseline_revision"} {
		if n := countRows(t, pool, table); n != 0 {
			t.Fatalf("%s still holds %d legacy rows after 9067", table, n)
		}
	}
	for _, table := range []string{"project_baseline_annotation_batch", "project_baseline_review", "project_baseline_annotation"} {
		if exists := baselineWikiTableExists(t, pool, schema, table); exists {
			t.Fatalf("%s survived 9067", table)
		}
	}
	if baselineWikiColumnExists(t, pool, schema, "project_baseline_page", "chapter") ||
		baselineWikiColumnExists(t, pool, schema, "project_baseline_revision", "status") ||
		baselineWikiColumnExists(t, pool, schema, "project_baseline_revision", "anchors_diff") {
		t.Fatal("legacy chapter/status/anchors_diff columns survived 9067")
	}
	for _, column := range []string{"slug", "title", "current_revision_id", "last_revision_number"} {
		baselineWikiColumnNotNull(t, pool, schema, "project_baseline_page", column)
	}
	for _, column := range []string{"page_id", "revision_kind", "title", "slug", "position"} {
		baselineWikiColumnNotNull(t, pool, schema, "project_baseline_revision", column)
	}
	slugCheck := baselineWikiConstraintDef(t, pool, schema, "project_baseline_page", "project_baseline_page_slug_check")
	if !strings.Contains(slugCheck, "^[a-z0-9][a-z0-9_-]{0,62}$") ||
		!strings.Contains(slugCheck, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") {
		t.Fatalf("page slug check: %s", slugCheck)
	}
	titleCheck := baselineWikiConstraintDef(t, pool, schema, "project_baseline_page", "project_baseline_page_title_check")
	if !strings.Contains(titleCheck, "char_length(title)") || !strings.Contains(titleCheck, ">= 1") || !strings.Contains(titleCheck, "<= 200") {
		t.Fatalf("page title check: %s", titleCheck)
	}
	kindCheck := baselineWikiConstraintDef(t, pool, schema, "project_baseline_revision", "project_baseline_revision_kind_check")
	for _, kind := range []string{"create", "content", "rename", "move", "archive", "restore", "rollback"} {
		if !strings.Contains(kindCheck, "'"+kind+"'") {
			t.Fatalf("revision kind check missing %q: %s", kind, kindCheck)
		}
	}
	for _, index := range []string{
		"idx_project_baseline_page_slug",
		"idx_project_baseline_revision_page",
		"idx_project_baseline_revision_activity",
	} {
		assertIndexExists(t, pool, schema, index, true)
	}

	// The checks accept the seven wiki revision kinds and reject bad shapes.
	if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_page
		(workspace_id, project_id, parent_id, current_revision_id, title, position, slug, last_revision_number)
		VALUES (`+wsID+`, `+projectID+`, NULL, '00000000-0000-0000-0000-000000000000', '首页', 0, 'home', 0)`); err != nil {
		t.Fatal(err)
	}
	for number, kind := range []string{"create", "content", "rename", "move", "archive", "restore", "rollback"} {
		if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_revision
			(workspace_id, project_id, page_id, revision_number, revision_kind, title, slug, position,
			 content_markdown, change_summary, created_by_type, created_by_id)
			VALUES (`+wsID+`, `+projectID+`, (SELECT id FROM project_baseline_page), `+string(rune('0'+number+1))+`,
			 '`+kind+`', '首页', 'home', 0, '正文', '摘要', 'member', gen_random_uuid())`); err != nil {
			t.Fatalf("insert %s revision: %v", kind, err)
		}
	}
	baselineWikiCheckRejects(t, pool, `INSERT INTO project_baseline_page
		(workspace_id, project_id, parent_id, current_revision_id, title, position, slug, last_revision_number)
		VALUES (`+wsID+`, `+projectID+`, NULL, '00000000-0000-0000-0000-000000000000', '坏', 0, 'BAD SLUG', 0)`)
	baselineWikiCheckRejects(t, pool, `INSERT INTO project_baseline_page
		(workspace_id, project_id, parent_id, current_revision_id, title, position, slug, last_revision_number)
		VALUES (`+wsID+`, `+projectID+`, NULL, '00000000-0000-0000-0000-000000000000', '坏', 0,
		'12345678-1234-1234-1234-123456789012', 0)`)

	// Roll the wiki migrations back: legacy skeletons return, empty.
	reversed := []string{"9070_labrastro_baseline_revision_activity_index", "9069_labrastro_baseline_revision_page_index",
		"9068_labrastro_baseline_page_slug_index", "9067_labrastro_baseline_wiki_pages"}
	run("down", reversed)
	if !baselineWikiTableExists(t, pool, schema, "project_baseline_doc", "project_baseline_page") {
		t.Fatal("9067 down did not restore project_baseline_doc")
	}
	for _, column := range []string{"chapter", "candidate_revision_id"} {
		if !baselineWikiColumnExists(t, pool, schema, "project_baseline_doc", column) {
			t.Fatalf("doc skeleton lost column %s", column)
		}
	}
	for _, column := range []string{"chapter", "status", "replaces_revision_id", "anchors_diff", "decided_at", "decision_credential"} {
		if !baselineWikiColumnExists(t, pool, schema, "project_baseline_revision", column) {
			t.Fatalf("revision skeleton lost column %s", column)
		}
	}
	for _, table := range []string{"project_baseline_annotation_batch", "project_baseline_review", "project_baseline_annotation"} {
		if !baselineWikiTableExists(t, pool, schema, table) {
			t.Fatalf("%s skeleton missing after 9067 down", table)
		}
		if n := countRows(t, pool, table); n != 0 {
			t.Fatalf("%s skeleton not empty: %d", table, n)
		}
	}
	for _, index := range []string{
		"idx_project_baseline_page_slug",
		"idx_project_baseline_revision_page",
		"idx_project_baseline_revision_activity",
	} {
		assertIndexExists(t, pool, schema, index, false)
	}

	// Re-applying up after the rollback is idempotent and lands the wiki shape
	// again; a second run of the same versions skips as already applied.
	run("up", baselineWikiVersions)
	run("up", baselineWikiVersions)
	assertIndexExists(t, pool, schema, "idx_project_baseline_page_slug", true)
	if !baselineWikiColumnExists(t, pool, schema, "project_baseline_page", "slug") {
		t.Fatal("wiki schema missing after idempotent re-run")
	}
}

func baselineWikiTableExists(t *testing.T, pool *pgxpool.Pool, schema string, tables ...string) bool {
	t.Helper()
	var exists bool
	// pg_class lookup across candidate names so both pre- and post-rename
	// shapes count as "the doc table".
	for _, table := range tables {
		if err := pool.QueryRow(context.Background(), `
			SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r')`, schema, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			return true
		}
	}
	return false
}

func countRows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}
