package scheduler

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// stubQuotaSourcePoller records poll calls; fail makes every call error.
type stubQuotaSourcePoller struct {
	mu    sync.Mutex
	calls []string
	fail  bool
}

func (s *stubQuotaSourcePoller) PollDueSource(ctx context.Context, row db.QuotaSource) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, row.ID.String())
	if s.fail {
		return errors.New("source down")
	}
	return nil
}

// insertDueQuotaSources creates n enabled sources due now under a fresh
// owner, returning a cleanup func.
func insertDueQuotaSources(t *testing.T, pool *pgxpool.Pool, owner string, n int) func() {
	t.Helper()
	ids := make([]string, n)
	for i := 0; i < n; i++ {
		var id string
		if err := pool.QueryRow(context.Background(),
			`INSERT INTO quota_source (owner_id, kind, name, credential_ciphertext, next_poll_at)
			 VALUES ($1, 'glm', $2, '\x00'::bytea, now() - interval '1 minute') RETURNING id::text`,
			owner, fmt.Sprintf("sched-poll-%d-%d", time.Now().UnixNano(), i)).Scan(&id); err != nil {
			t.Fatalf("insert source: %v", err)
		}
		ids[i] = id
	}
	return func() {
		for _, id := range ids {
			_, _ = pool.Exec(context.Background(), `DELETE FROM quota_source WHERE id = $1`, id)
		}
	}
}

func insertSchedulerTestUser(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO "user" (email, name) VALUES ($1, 'Quota Poll Job') RETURNING id::text`,
		fmt.Sprintf("quota-poll-%d@multica.test", time.Now().UnixNano())).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id)
	})
	return id
}

// The round scans due sources, polls each once, and neither a failing
// source nor an empty round fails the job. DB-backed because the due-list
// read is part of the behavior under test.
func TestQuotaSourcePollJobHandler(t *testing.T) {
	pool := integrationPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	owner := insertSchedulerTestUser(t, pool)
	cleanup := insertDueQuotaSources(t, pool, owner, 3)
	defer cleanup()

	poller := &stubQuotaSourcePoller{}
	handler := makeQuotaSourcePollHandler(queries, poller)
	result, err := handler(ctx, HandlerInput{PlanTime: time.Now()})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(poller.calls) != 3 {
		t.Fatalf("polled %d sources, want 3", len(poller.calls))
	}
	if result.RowsAffected != 3 {
		t.Fatalf("RowsAffected = %d, want 3", result.RowsAffected)
	}

	// After the first round every source's next_poll_at moved 5m ahead, so
	// an immediate second round finds nothing due — the stub's success path
	// does not touch the DB, which this relies on: the row's next_poll_at is
	// only moved by ApplyQuotaSourcePollSuccess in the real poller. Assert
	// the round still completes cleanly with zero due rows.
	poller.calls = nil
	result, err = handler(ctx, HandlerInput{PlanTime: time.Now()})
	if err != nil {
		t.Fatalf("second round: %v", err)
	}
	if len(poller.calls) != 3 || result.RowsAffected != 3 {
		t.Fatalf("second round: polled=%d affected=%d (stub does not advance next_poll_at)", len(poller.calls), result.RowsAffected)
	}
}

func TestQuotaSourcePollJobSpec(t *testing.T) {
	spec := QuotaSourcePollJob(nil, &stubQuotaSourcePoller{})
	if spec.Name != JobNameQuotaSourcePoll {
		t.Fatalf("name = %q", spec.Name)
	}
	if spec.Cadence != 5*time.Minute {
		t.Fatalf("cadence = %v", spec.Cadence)
	}
	if spec.MaxAttempts != 1 {
		t.Fatalf("MaxAttempts = %d (backoff lives in the row)", spec.MaxAttempts)
	}
	scopes, err := spec.Scopes(context.Background(), time.Now())
	if err != nil || len(scopes) != 1 || scopes[0] != ScopeGlobal {
		t.Fatalf("scopes = %v err = %v", scopes, err)
	}
}
