package migrations

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestMediaBaselineFreshUpgradeAndRollback(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	files, err := filepath.Glob("../../migrations/90*.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	var selected []string
	for _, p := range files {
		if filepath.Base(p) >= "9035_" && filepath.Base(p) < "9052_" {
			selected = append(selected, filepath.Base(p))
		}
	}
	if len(selected) != 17 {
		t.Fatalf("missing media migration inventory: %d", len(selected))
	}
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("upgrade_%v", existing), func(t *testing.T) {
			schema := fmt.Sprintf("media_baseline_%d", time.Now().UnixNano())
			exec := func(sql string) {
				t.Helper()
				if _, err := conn.Exec(ctx, sql); err != nil {
					t.Fatal(err)
				}
			}
			exec("CREATE SCHEMA " + schema)
			defer conn.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
			exec("SET search_path TO " + schema + ", public")
			exec("CREATE TABLE attachment(id UUID NOT NULL)")
			if existing {
				exec("INSERT INTO attachment VALUES(gen_random_uuid())")
			}
			for _, file := range selected {
				exec(readMigrationFile(t, file))
			}
			// Replaying the additive DDL must preserve an existing installation.
			exec(readMigrationFile(t, selected[0]))
			var valid, unique int
			if err := conn.QueryRow(ctx, `SELECT count(*) FILTER(WHERE indisvalid),count(*) FILTER(WHERE indisunique) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1`, schema).Scan(&valid, &unique); err != nil {
				t.Fatal(err)
			}
			if valid != 16 || unique != 11 {
				t.Fatalf("index catalog valid=%d unique=%d", valid, unique)
			}
			var oldRows int
			if err := conn.QueryRow(ctx, "SELECT count(*) FROM attachment WHERE sha256 IS NULL").Scan(&oldRows); err != nil {
				t.Fatal(err)
			}
			if existing && oldRows != 1 {
				t.Fatal("upgrade changed old attachment")
			}
			for i := len(selected) - 1; i >= 0; i-- {
				file := selected[i]
				exec(readMigrationFile(t, file[:len(file)-len("up.sql")]+"down.sql"))
			}
			var remaining int
			if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema=$1`, schema).Scan(&remaining); err != nil {
				t.Fatal(err)
			}
			if remaining != 1 {
				t.Fatalf("rollback left %d tables", remaining)
			}
		})
	}
}
