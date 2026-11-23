package seatcapacity

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// testLockerPool opens a small pool against DATABASE_URL, skipping the test
// where no database is configured (the worker suites run without one).
func testLockerPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Skipf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Skipf("database not reachable: %v", err)
	}
	conn.Release()
	return pool
}

// The seat-capacity default constructor must keep its cooldown: Cloud capacity
// calls for one workspace may not run back to back. Losing it would be a
// silent behavior change of NewWorkspaceLocker, the constructor the handler
// wires up; an explicit zero-cooldown caller stays fast by contrast.
func TestNewWorkspaceLockerKeepsSeatCapacityCooldown(t *testing.T) {
	pool := testLockerPool(t)
	ctx := context.Background()
	workspaceID := uuid.New()

	measure := func(locker WorkspaceLocker) (time.Duration, error) {
		start := time.Now()
		_, release, err := locker.Lock(ctx, workspaceID)
		if err != nil {
			return 0, err
		}
		release()
		return time.Since(start), nil
	}
	timedRelease := func(locker WorkspaceLocker) time.Duration {
		t.Helper()
		d, err := measure(locker)
		if err != nil {
			t.Fatalf("lock: %v", err)
		}
		return d
	}

	defaultLocker := NewWorkspaceLocker(pool)
	zeroLocker := NewWorkspaceLockerWithOptions(pool, WorkspaceLockerOptions{
		Namespace: defaultWorkspaceLockNamespace,
	})

	for round := range 3 {
		zero := timedRelease(zeroLocker)
		def := timedRelease(defaultLocker)
		t.Logf("round %d: zero cooldown %v, seat-capacity default %v", round, zero, def)
		if zero > 50*time.Millisecond {
			t.Fatalf("round %d: an explicit zero-cooldown release took %v, want well under the 75ms cooldown", round, zero)
		}
		if def < 60*time.Millisecond {
			t.Fatalf("round %d: the seat-capacity default released in %v, want the 75ms cooldown observed", round, def)
		}
	}
}
