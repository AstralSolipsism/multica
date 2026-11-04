package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// JobNameQuotaSourcePoll polls user-registered subscription quota sources
// (OL-1205 scenario 3).
const JobNameQuotaSourcePoll = "quota_source_poll"

// QuotaSourcePoller is the per-source collection callback injected by the
// handler layer (it owns the decryption box and the driver registry).
// Returning an error records a failure with backoff on the row.
type QuotaSourcePoller interface {
	PollDueSource(ctx context.Context, row db.QuotaSource) error
}

// QuotaSourcePollJob polls every enabled quota source whose next_poll_at has
// elapsed. Backoff lives in the row (next_poll_at), so the job itself is a
// flat scan; workers are bounded because each fetch is a network round trip
// with a 15s timeout.
func QuotaSourcePollJob(queries *db.Queries, poller QuotaSourcePoller) JobSpec {
	return JobSpec{
		Name:              JobNameQuotaSourcePoll,
		Cadence:           5 * time.Minute,
		CatchUpMode:       CatchUpLatestOnly,
		CatchUpWindow:     30 * time.Minute,
		RunTimeout:        4 * time.Minute,
		StaleTimeout:      5 * time.Minute,
		HeartbeatInterval: 30 * time.Second,
		AllowStaleReentry: true,
		MaxAttempts:       1,
		Scopes:            StaticScopes(ScopeGlobal),
		Handler:           makeQuotaSourcePollHandler(queries, poller),
	}
}

// quotaSourcePollConcurrency bounds concurrent provider fetches per round.
const quotaSourcePollConcurrency = 8

// quotaSourcePollBatch caps rows read per round; with the 20-per-user cap
// this is generous headroom.
const quotaSourcePollBatch = 500

func makeQuotaSourcePollHandler(queries *db.Queries, poller QuotaSourcePoller) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		rows, err := queries.ListDueQuotaSources(ctx, db.ListDueQuotaSourcesParams{
			Now:        pgtype.Timestamptz{Time: in.PlanTime, Valid: true},
			MaxSources: quotaSourcePollBatch,
		})
		if err != nil {
			return HandlerResult{}, fmt.Errorf("quota source poll: list due: %w", err)
		}
		if len(rows) == 0 {
			return HandlerResult{}, nil
		}
		var (
			mu       sync.Mutex
			affected int
		)
		sem := make(chan struct{}, quotaSourcePollConcurrency)
		var wg sync.WaitGroup
		for _, row := range rows {
			if ctx.Err() != nil {
				break
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(row db.QuotaSource) {
				defer wg.Done()
				defer func() { <-sem }()
				if err := poller.PollDueSource(ctx, row); err != nil {
					slog.Warn("quota source poll failed", "source_id", row.ID.String(), "error", err)
				} else {
					mu.Lock()
					affected++
					mu.Unlock()
				}
			}(row)
			if in.Heartbeat != nil {
				_ = in.Heartbeat(ctx)
			}
		}
		wg.Wait()
		return HandlerResult{
			RowsAffected: int64(affected),
			Result:       map[string]any{"due": len(rows), "polled": affected},
		}, nil
	}
}
