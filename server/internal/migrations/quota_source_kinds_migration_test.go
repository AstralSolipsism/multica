package migrations

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const quotaSourceKindsMigrationTestSchema = "quota_source_kinds_migration_test"

// OL-1369 stage 1: 9076 widens quota_source.kind to the global monitor set
// and lets jev_free rows store an empty credential ciphertext. Up/down plus
// the insert-level constraint behavior, on an isolated schema.
func TestQuotaSourceKindsExpandMigrationsUpDown(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to Postgres: %v", err)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire Postgres connection: %v", err)
	}
	defer conn.Release()

	cleanup := func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotaSourceKindsMigrationTestSchema+" CASCADE")
	}
	cleanup()
	t.Cleanup(cleanup)
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+quotaSourceKindsMigrationTestSchema); err != nil {
		t.Fatalf("create isolated migration schema: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('search_path', $1, false)`, quotaSourceKindsMigrationTestSchema); err != nil {
		t.Fatalf("set isolated migration search path: %v", err)
	}

	applyMigrationFile(t, ctx, conn.Conn(), "9049_labrastro_quota_source_tables.up.sql")

	// Baseline behavior before 9076: the widened kinds and the empty
	// ciphertext are both rejected.
	assertQuotaSourceCheckViolation(t, ctx, conn.Conn(), "deepseek", []byte("x"))
	assertQuotaSourceCheckViolation(t, ctx, conn.Conn(), "glm", []byte{})

	applyMigrationFile(t, ctx, conn.Conn(), "9076_labrastro_quota_source_kinds_expand.up.sql")

	insertQuotaSource := func(kind string, ciphertext []byte) error {
		_, err := conn.Exec(ctx, `
			INSERT INTO quota_source (owner_id, kind, name, credential_ciphertext)
			VALUES ('00000000-0000-0000-0000-000000000001', $1, 'probe', $2)
		`, kind, ciphertext)
		return err
	}
	for _, kind := range []string{"glm", "zenmux", "deepseek", "opencode"} {
		if err := insertQuotaSource(kind, []byte("sealed")); err != nil {
			t.Fatalf("insert %s with ciphertext after up: %v", kind, err)
		}
	}
	// jev_free is exactly the kind allowed to persist without a credential.
	if err := insertQuotaSource("jev_free", []byte{}); err != nil {
		t.Fatalf("insert jev_free with empty ciphertext after up: %v", err)
	}
	// Credentialed kinds still require a non-empty ciphertext, and unknown
	// kinds stay rejected.
	assertQuotaSourceCheckViolation(t, ctx, conn.Conn(), "glm", []byte{})
	assertQuotaSourceCheckViolation(t, ctx, conn.Conn(), "unknown", []byte("sealed"))

	applyMigrationFile(t, ctx, conn.Conn(), "9076_labrastro_quota_source_kinds_expand.down.sql")

	// The down migration deletes the widened kinds' rows itself; the table
	// must accept the original two-kind shape again.
	if err := insertQuotaSource("zenmux", []byte("sealed")); err != nil {
		t.Fatalf("insert zenmux after down: %v", err)
	}
	assertQuotaSourceCheckViolation(t, ctx, conn.Conn(), "deepseek", []byte("sealed"))
	assertQuotaSourceCheckViolation(t, ctx, conn.Conn(), "glm", []byte{})
}

func assertQuotaSourceCheckViolation(t *testing.T, ctx context.Context, conn interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, kind string, ciphertext []byte) {
	t.Helper()
	_, err := conn.Exec(ctx, `
		INSERT INTO quota_source (owner_id, kind, name, credential_ciphertext)
		VALUES ('00000000-0000-0000-0000-000000000002', $1, 'probe', $2)
	`, kind, ciphertext)
	if !isCheckViolation(err) {
		t.Fatalf("insert kind=%s len(ciphertext)=%d: got %v, want check violation", kind, len(ciphertext), err)
	}
}
