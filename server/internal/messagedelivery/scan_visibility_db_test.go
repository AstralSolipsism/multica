package messagedelivery

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestSourceScanHorizonPreservesInvisibleWriter(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var superuser bool
	var prepared int
	testFx.QueryRow(t, `SELECT rolsuper, current_setting('max_prepared_transactions')::integer
		FROM pg_roles WHERE rolname=current_user`).Scan(&superuser, &prepared)
	if !superuser {
		t.Skip("requires an admin fixture to create two ordinary login roles and grant monitoring")
	}
	if prepared != 0 {
		t.Skip("two-phase commit independently pins the horizon to epoch")
	}
	// Real login sessions are required: SET ROLE leaves the backend's
	// authenticated identity unchanged in pg_stat_activity.
	newRole := func() (*pgx.Conn, string) {
		t.Helper()
		role := "md_visibility_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		quoted := pgx.Identifier{role}.Sanitize()
		password := uuid.NewString()
		testFx.Exec(t, "CREATE ROLE "+quoted+" LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'")
		database := pgx.Identifier{testPool.Config().ConnConfig.Database}.Sanitize()
		t.Cleanup(func() {
			cleanupCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if _, err := testPool.Exec(cleanupCtx, "REVOKE CONNECT ON DATABASE "+database+" FROM "+quoted); err != nil {
				t.Errorf("revoke test database access: %v", err)
			}
			if _, err := testPool.Exec(cleanupCtx, "DROP ROLE "+quoted); err != nil {
				t.Errorf("drop test role: %v", err)
			}
		})
		testFx.Exec(t, "GRANT CONNECT ON DATABASE "+database+" TO "+quoted)
		cfg := testPool.Config().ConnConfig.Copy()
		cfg.User, cfg.Password = role, password
		conn, err := pgx.ConnectConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close(context.Background()) })
		return conn, quoted
	}
	writer, _ := newRole()
	observer, observerRole := newRole()
	tx, err := writer.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var started time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&started); err != nil {
		t.Fatal(err)
	}
	var userVisible, activityHidden bool
	if err := observer.QueryRow(ctx, `SELECT usesysid IS NOT NULL, state IS NULL AND xact_start IS NULL
		FROM pg_stat_activity WHERE pid=$1`, writer.PgConn().PID()).Scan(&userVisible, &activityHidden); err != nil {
		t.Fatal(err)
	}
	if !userVisible || !activityHidden {
		t.Fatal("fixture must expose the writer's user but hide its transaction state")
	}
	horizon, err := db.New(observer).GetLabrastroMessageSourceScanHorizon(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !horizon.StableAt.Time.Equal(time.Unix(0, 0)) {
		t.Fatalf("invisible writer allowed horizon to advance to %v", horizon.StableAt.Time)
	}
	// The documented multi-role setup makes the same active writer observable.
	testFx.Exec(t, "GRANT pg_read_all_stats TO "+observerRole)
	horizon, err = db.New(observer).GetLabrastroMessageSourceScanHorizon(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !horizon.StableAt.Time.After(time.Unix(0, 0)) || horizon.StableAt.Time.After(started) {
		t.Fatalf("observable writer horizon=%v, want after epoch and no later than %v", horizon.StableAt.Time, started)
	}
}
