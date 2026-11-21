package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/inboxread"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestInboxReadPostgresTimeoutAndLocalSettings(t *testing.T) {
	conn, err := testPool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	var before string
	if err := conn.QueryRow(context.Background(), "SHOW statement_timeout").Scan(&before); err != nil {
		t.Fatal(err)
	}
	g := inboxread.New(inboxread.Config{Concurrency: 1, StatementTimeout: 50 * time.Millisecond})
	start := time.Now()
	err = g.Run(context.Background(), "summary", conn, func(ctx context.Context, tx pgx.Tx) error {
		var timeout, readOnly string
		if err := tx.QueryRow(ctx, "SELECT current_setting('statement_timeout'), current_setting('transaction_read_only')").Scan(&timeout, &readOnly); err != nil {
			return err
		}
		if timeout != "50ms" || readOnly != "on" {
			t.Errorf("transaction settings = %s, %s", timeout, readOnly)
		}
		_, err := tx.Exec(ctx, "SELECT pg_sleep(2)")
		return err
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "57014" {
		t.Fatalf("database did not terminate slow SQL: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("statement timeout took too long")
	}
	var after string
	if err := conn.QueryRow(context.Background(), "SHOW statement_timeout").Scan(&after); err != nil {
		t.Fatalf("connection not reusable after rollback: %v", err)
	}
	if after != before {
		t.Fatalf("transaction setting leaked: before %s after %s", before, after)
	}
	if err := g.Run(context.Background(), "list", conn, func(ctx context.Context, tx pgx.Tx) error { _, err := tx.Exec(ctx, "SELECT 1"); return err }); err != nil {
		t.Fatalf("permit/transaction leaked: %v", err)
	}
}

func TestInboxReadCallerCancellationKeepsDatabaseBudget(t *testing.T) {
	g := inboxread.New(inboxread.Config{Concurrency: 1, StatementTimeout: 50 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := g.Run(ctx, "list", testPool, func(ctx context.Context, tx pgx.Tx) error {
		cancel()
		if ctx.Err() != nil {
			t.Fatalf("caller canceled active SQL context: %v", ctx.Err())
		}
		_, err := tx.Exec(ctx, "SELECT pg_sleep(2)")
		return err
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "57014" {
		t.Fatalf("permit returned before database timeout: %v", err)
	}
}

func TestAllInboxReadHandlersShareCapacity(t *testing.T) {
	h := *testHandler
	h.InboxReads = inboxread.New(inboxread.Config{Concurrency: 1})
	started, finish, result := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		result <- h.InboxReads.Run(context.Background(), "summary", testPool, func(context.Context, pgx.Tx) error { close(started); <-finish; return nil })
	}()
	<-started
	defer func() {
		close(finish)
		if err := <-result; err != nil {
			t.Error(err)
		}
	}()
	for _, endpoint := range []struct {
		path    string
		handler http.HandlerFunc
	}{
		{"/api/inbox", h.ListInbox},
		{"/api/inbox?view=grouped", h.ListInbox},
		{"/api/inbox/unread-count", h.CountUnreadInbox},
		{"/api/inbox/unread-summary", h.UnreadInboxSummary},
		{"/api/inbox/snoozed", h.ListSnoozedInbox},
		{"/api/inbox/archived", h.ListArchivedInbox},
		{"/api/inbox/archived/page", h.ListArchivedInboxPage},
		{"/api/inbox/archived/facets", h.GetArchivedInboxFacets},
	} {
		t.Run(endpoint.path, func(t *testing.T) {
			rec := testutil.Call(t, inboxWorkspaceHandler(endpoint.handler), inboxRequest(http.MethodGet, endpoint.path, testWorkspaceID)).Want(http.StatusServiceUnavailable)
			if rec.Header().Get("Retry-After") != "1" {
				t.Fatal("missing Retry-After")
			}
		})
	}
}

type getWorkspaceCounter struct {
	db.DBTX
	reads atomic.Int32
}

func (c *getWorkspaceCounter) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "name: GetWorkspace") {
		c.reads.Add(1)
	}
	return c.DBTX.QueryRow(ctx, sql, args...)
}

func TestListInboxAdmissionRejectionSkipsIssuePrefixQuery(t *testing.T) {
	obs := &getWorkspaceCounter{DBTX: testPool}
	h := *testHandler
	h.Queries = db.New(obs)
	h.InboxReads = inboxread.New(inboxread.Config{Concurrency: 1})

	// Sanity check: admitted requests execute getIssuePrefix via GetWorkspace.
	for _, path := range []string{"/api/inbox", "/api/inbox?view=grouped"} {
		obs.reads.Store(0)
		testutil.Call(t, inboxWorkspaceHandler(h.ListInbox), inboxRequest(http.MethodGet, path, testWorkspaceID)).Want(http.StatusOK)
		if got := obs.reads.Load(); got != 1 {
			t.Fatalf("admitted %s: GetWorkspace reads = %d, want 1", path, got)
		}
	}

	// Saturate admission capacity; neither flat nor grouped ListInbox may run
	// the workspace issue-prefix query before runInboxRead admits the request.
	started, finish, result := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		result <- h.InboxReads.Run(context.Background(), "list", testPool, func(context.Context, pgx.Tx) error {
			close(started)
			<-finish
			return nil
		})
	}()
	<-started
	defer func() {
		close(finish)
		if err := <-result; err != nil {
			t.Error(err)
		}
	}()

	for _, path := range []string{"/api/inbox", "/api/inbox?view=grouped"} {
		t.Run(path, func(t *testing.T) {
			obs.reads.Store(0)
			rec := testutil.Call(t, inboxWorkspaceHandler(h.ListInbox), inboxRequest(http.MethodGet, path, testWorkspaceID)).Want(http.StatusServiceUnavailable)
			if rec.Header().Get("Retry-After") != "1" {
				t.Fatal("missing Retry-After")
			}
			if got := obs.reads.Load(); got != 0 {
				t.Fatalf("rejected %s executed %d GetWorkspace (issue_prefix) queries before admission", path, got)
			}
		})
	}
}

func TestInboxReadErrorContract(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{
		{inboxread.ErrBusy, 503},
		{context.DeadlineExceeded, 503},
		{&pgconn.PgError{Code: "57014"}, 503},
		{&pgconn.PgError{Code: "42P01"}, 500},
		{context.Canceled, 499},
	} {
		rec := httptest.NewRecorder()
		writeInboxReadError(rec, tc.err, "failed to read inbox")
		if rec.Code != tc.status {
			t.Fatalf("%v => %d, want %d", tc.err, rec.Code, tc.status)
		}
		if tc.status == 503 && rec.Header().Get("Retry-After") != "1" {
			t.Fatal("missing Retry-After")
		}
		if tc.status == 499 && rec.Body.Len() != 0 {
			t.Fatal("wrote a body after cancellation")
		}
	}
}

// This local database stress test verifies connection isolation with three
// independent API budgets. It does not measure staging CPU or daemon API SLOs.
func TestInboxReadThreeInstancesBoundSlowSQL(t *testing.T) {
	const instances, requestsPerInstance = 3, 30 // 10x a list/summary/snoozed refresh.
	var pools [instances]*pgxpool.Pool
	var guards [instances]*inboxread.Guard
	var active, peak [instances]atomic.Int32
	var accepted, refused atomic.Int32
	started := make(chan struct{}, instances*2)
	results := make(chan error, instances*requestsPerInstance)
	for instance := range instances {
		cfg := testPool.Config().Copy()
		cfg.MaxConns, cfg.MinConns = 25, 0
		pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		if err := pool.Ping(context.Background()); err != nil {
			t.Fatal(err)
		}
		pools[instance] = pool
		guards[instance] = inboxread.New(inboxread.Config{Concurrency: 2})
	}
	for instance := range instances {
		for range requestsPerInstance {
			go func() {
				err := guards[instance].Run(context.Background(), "list", pools[instance], func(ctx context.Context, tx pgx.Tx) error {
					n := active[instance].Add(1)
					defer active[instance].Add(-1)
					for previous := peak[instance].Load(); n > previous; previous = peak[instance].Load() {
						if peak[instance].CompareAndSwap(previous, n) {
							break
						}
					}
					select {
					case started <- struct{}{}:
					default:
					}
					_, err := tx.Exec(ctx, "SELECT pg_sleep(2)")
					return err
				})
				if err == nil {
					accepted.Add(1)
				} else if inboxread.IsUnavailable(err) {
					refused.Add(1)
					err = nil
				}
				results <- err
			}()
		}
	}
	for range instances * 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("slow reads did not start")
		}
	}
	var controls sync.WaitGroup
	controlResults := make(chan error, instances)
	var maxControlLatency [instances]time.Duration
	for instance := range instances {
		controls.Go(func() {
			for range 50 {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				start := time.Now()
				var value int
				err := pools[instance].QueryRow(ctx, "SELECT 1").Scan(&value)
				cancel()
				maxControlLatency[instance] = max(maxControlLatency[instance], time.Since(start))
				if err != nil {
					controlResults <- err
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			controlResults <- nil
		})
	}
	controls.Wait()
	for range instances {
		if err := <-controlResults; err != nil {
			t.Errorf("unrelated database read failed: %v", err)
		}
	}
	for range instances * requestsPerInstance {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
	for instance := range instances {
		if n := peak[instance].Load(); n > 2 {
			t.Errorf("instance %d ran %d inbox queries", instance, n)
		}
		t.Logf("instance=%d peak_inbox_queries=%d max_control_latency=%s", instance, peak[instance].Load(), maxControlLatency[instance])
	}
	if refused.Load() == 0 {
		t.Error("burst did not exercise overload rejection")
	}
	t.Logf("inbox_requests=%d accepted=%d unavailable=%d control_reads=%d", instances*requestsPerInstance, accepted.Load(), refused.Load(), instances*50)
}
