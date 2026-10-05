package messagedelivery

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestScanScheduleCoalescesAndRetainsTrailingWakeup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		notify := make(chan struct{}, 1)
		var decisions, scans atomic.Int32
		go runScanSchedule(ctx, 10*time.Second, time.Second, notify,
			func() { scans.Add(1) }, func() { decisions.Add(1) })
		wake := func() {
			for range 100 {
				select {
				case notify <- struct{}{}:
				default:
				}
			}
			synctest.Wait()
		}
		wake()
		if decisions.Load() != 1 {
			t.Fatalf("first wakeup: %d decisions", decisions.Load())
		}
		for range 9 {
			time.Sleep(100 * time.Millisecond)
			wake()
			if decisions.Load() != 1 {
				t.Fatal("burst bypassed minimum interval")
			}
		}
		time.Sleep(100 * time.Millisecond)
		synctest.Wait()
		if decisions.Load() != 2 {
			t.Fatal("trailing wakeup lost or postponed by continuous events")
		}
		time.Sleep(9 * time.Second)
		synctest.Wait()
		if scans.Load() != 1 {
			t.Fatal("periodic compensation was starved")
		}
		wake()
		if decisions.Load() != 2 {
			t.Fatal("event immediately repeated periodic decision scan")
		}
		cancel()
		synctest.Wait()
		time.Sleep(time.Second)
		if decisions.Load() != 2 {
			t.Fatal("pending wakeup ran after shutdown")
		}
	})
}

func TestSourceWatermarksBoundHistoryAndSurviveRestart(t *testing.T) {
	for _, scope := range []string{RouteSourceInbox, RouteSourceActivity, RouteSourceComment} {
		t.Run(scope, func(t *testing.T) {
			ctx := context.Background()
			resetSourceScanCursors(t)
			fx := newSourceFixture(t, "watermark-"+scope)
			older := testutil.Cols{"effective_from": testutil.Raw("now() - interval '2 hours'")}
			table := ""
			var insert func() string
			switch scope {
			case RouteSourceInbox:
				fx.bindMember(t, testUID, "ou_watermark")
				fx.personalRoute(t, scope, testUID, older)
				table, insert = "inbox_item", func() string { return fx.inboxItem(t, testUID, "status_changed", fx.issue) }
			case RouteSourceActivity:
				fx.approveTeam(t, scope, "oc_watermark")
				fx.teamRoute(t, scope, scope, "oc_watermark", older)
				table, insert = "activity_log", func() string { return fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"done"}`) }
			case RouteSourceComment:
				fx.approveTeam(t, scope, "oc_watermark")
				fx.teamRoute(t, scope, scope, "oc_watermark", older)
				table, insert = "comment", func() string { return fx.comment(t, fx.issue, "watermark") }
			}
			old := insert()
			testFx.Exec(t, "UPDATE "+table+" SET created_at=now()-interval '1 hour' WHERE id=$1", old)
			s := newTestService(nil, nil)
			if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
				t.Fatal(errs)
			}
			if countSourceDecisions(t, old) != 1 {
				t.Fatal("bootstrap skipped historical eligible source")
			}
			// Removing the old decision makes revisiting old history observable.
			testFx.Exec(t, "DELETE FROM labrastro_message_delivery WHERE source_ref_id=$1", old)
			fresh := insert()
			// Process restart and clock skew must use the persisted DB horizon.
			s = newTestService(nil, nil)
			s.Now = func() time.Time { return time.Now().Add(24 * time.Hour) }
			for range 2 {
				if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
					t.Fatal(errs)
				}
			}
			if countSourceDecisions(t, old) != 0 || countSourceDecisions(t, fresh) != 1 {
				t.Fatal("steady scan revisited old history or lost/duplicated a fresh source")
			}
		})
	}
}

func TestSourceWatermarkHoldsBehindOpenTransaction(t *testing.T) {
	ctx := context.Background()
	resetSourceScanCursors(t)
	fx := newSourceFixture(t, "watermark-transaction")
	fx.approveTeam(t, RouteSourceActivity, "oc_transaction")
	fx.teamRoute(t, "activity", RouteSourceActivity, "oc_transaction", nil)
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var started time.Time
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO activity_log(workspace_id,issue_id,action,details)
		VALUES ($1,$2,'status_changed','{"from":"todo","to":"done"}') RETURNING id,created_at`, testWSID, fx.issue).Scan(&id, &started)
	if err != nil {
		t.Fatal(err)
	}
	testFx.Cleanup(t, "DELETE FROM activity_log WHERE id=$1", id)
	s := newTestService(nil, nil)
	for range 3 {
		if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
			t.Fatal(errs)
		}
		row, err := s.Queries.GetLabrastroMessageScanCursor(ctx, scannerActivitySource)
		if err != nil {
			t.Fatal(err)
		}
		if row.CursorTs.Time.After(started) {
			t.Fatal("stable watermark passed an uncommitted source")
		}
	}
	if countSourceDecisions(t, id) != 0 {
		t.Fatal("uncommitted source was decided")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if countSourceDecisions(t, id) != 1 {
		t.Fatal("natural next window lost late commit")
	}
}

func TestSourceWatermarkFailureAndStaleReplicaCannotAdvance(t *testing.T) {
	ctx := context.Background()
	resetSourceScanCursors(t)
	s := newTestService(nil, nil)
	cur, err := s.loadCursor(ctx, scannerCommentSource)
	if err != nil {
		t.Fatal(err)
	}
	pageFailure := errors.New("decision unavailable")
	_, err = s.advanceScanner(ctx, scannerCommentSource, func(context.Context, scanCursor) (scanCursor, error) {
		return scanCursor{}, pageFailure
	})
	if !errors.Is(err, pageFailure) {
		t.Fatal(err)
	}
	reloaded, err := s.loadCursor(ctx, scannerCommentSource)
	if err != nil || reloaded != cur {
		t.Fatalf("failed page changed cursor: %v", err)
	}
	if _, err := s.advanceScanner(ctx, scannerCommentSource, s.scanCommentSourceDecisions); err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveCursor(ctx, scannerCommentSource, cur); !errors.Is(err, errScanCursorMoved) {
		t.Fatalf("stale replica overwrote completed watermark: %v", err)
	}
}

type scanQueryRecorder struct {
	*pgxpool.Pool
	queries []string
}

func (r *scanQueryRecorder) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	r.queries = append(r.queries, sql)
	return r.Pool.Query(ctx, sql, args...)
}

func (r *scanQueryRecorder) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	r.queries = append(r.queries, sql)
	return r.Pool.QueryRow(ctx, sql, args...)
}

func TestDecideMissingUsesCandidateFactsWithoutReloadingEachRun(t *testing.T) {
	fx := newMDFixture(t, "candidate-facts", nil)
	fx.groupRoute(t, "oc_candidate_one")
	fx.groupRoute(t, "oc_candidate_two")
	runs := []string{fx.run(t, "completed", nil), fx.run(t, "failed", nil)}
	r := &scanQueryRecorder{Pool: testPool}
	s := newTestService(nil, nil)
	s.Queries = db.New(r)
	if err := s.decideMissing(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, run := range runs {
		if n := countDeliveries(t, "run_id=$1", run); n != 2 {
			t.Fatalf("run has %d decisions, want both routes", n)
		}
	}
	for _, sql := range r.queries {
		for _, name := range []string{"GetAutopilotRun", "GetAutopilot", "GetAutopilotTaskByRun", "ListEnabledLabrastroMessageRoutesByAutopilot"} {
			if strings.HasPrefix(sql, "-- name: "+name+" ") {
				t.Fatalf("candidate scan reloaded metadata with %s", name)
			}
		}
	}
}
