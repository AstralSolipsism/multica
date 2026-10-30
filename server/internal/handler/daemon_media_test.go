package handler

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func fixtureMediaReport() *protocol.MediaExecutorReport {
	return &protocol.MediaExecutorReport{ConnectionID: uuid.NewString(), Executors: []protocol.MediaExecutorDescriptor{{ExecutorID: uuid.NewString(), CredentialScopeID: uuid.NewString(), Provider: "codex", ResolvedProvider: "codex", Capability: protocol.MediaImageCodexV1, DescriptorVersion: 1, Readiness: protocol.MediaReady, ObservedAt: time.Now().Unix(), MaxConcurrency: 1, Models: []string{"fixture-model"}, OutputFormats: []string{"png"}, QuotaRef: protocol.MediaQuotaRef{ScopeID: uuid.NewString()}}}}
}
func saveFixtureMedia(t *testing.T, rtID string, r *protocol.MediaExecutorReport, register bool) error {
	t.Helper()
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := testHandler.Queries.WithTx(tx)
	rt, err := q.GetAgentRuntime(ctx, parseUUID(rtID))
	if err != nil {
		return err
	}
	if err = persistMediaReport(ctx, q, rt, r, register); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func TestMediaReRegistrationPreservesReservationsAndProfileIsolation(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	rtID := dbfx.Runtime(t, "media", testutil.Cols{"provider": "media", "daemon_id": uuid.NewString(), "status": "online", "last_seen_at": time.Now()})
	a, b := fixtureMediaReport(), fixtureMediaReport()
	defer dbfx.Exec(t, "DELETE FROM media_executor WHERE runtime_id=$1", rtID)
	for _, r := range []*protocol.MediaExecutorReport{a, b} {
		if err := saveFixtureMedia(t, rtID, r, true); err != nil {
			t.Fatal(err)
		}
	}
	dbfx.Exec(t, "UPDATE media_executor SET cooldown_until=now()+interval '1 hour',in_flight=1 WHERE executor_id=$1", a.Executors[0].ExecutorID)
	// An unresolved attempt must survive discovery, regardless of lease expiry.
	jobID, attemptID := uuid.NewString(), uuid.NewString()
	dbfx.Exec(t, `INSERT INTO media_job_attempt(id,workspace_id,job_id,runtime_id,executor_id,connection_id,operation_id,fence,lease_expires_at,submission_state)
 VALUES($1,$2,$3,$4,$5,$6,$7,1,now()+interval '1 minute','unknown')`, attemptID, testWorkspaceID, jobID, rtID, a.Executors[0].ExecutorID, a.ConnectionID, uuid.NewString())
	defer dbfx.Exec(t, "DELETE FROM media_job_attempt WHERE id=$1", attemptID)
	if err := saveFixtureMedia(t, rtID, a, true); err != nil {
		t.Fatal(err)
	}
	var occupied int
	var cooling bool
	dbfx.QueryRow(t, "SELECT in_flight,cooldown_until>now() FROM media_executor WHERE executor_id=$1", a.Executors[0].ExecutorID).Scan(&occupied, &cooling)
	if occupied != 1 || !cooling {
		t.Fatal("re-registration erased reservation/cooldown")
	}
	var state string
	dbfx.QueryRow(t, "SELECT submission_state FROM media_job_attempt WHERE id=$1", attemptID).Scan(&state)
	if state != "unknown" {
		t.Fatal("re-registration altered unfinished attempt")
	}
	foreign := *a
	foreign.ConnectionID = uuid.NewString()
	if err := saveFixtureMedia(t, rtID, &foreign, true); err == nil {
		t.Fatal("live connection lease stolen")
	}
	if err := saveFixtureMedia(t, rtID, &foreign, false); err == nil {
		t.Fatal("heartbeat stole connection")
	}
	rt, err := testHandler.Queries.GetAgentRuntime(ctx, parseUUID(rtID))
	if err != nil {
		t.Fatal(err)
	}
	if err := testHandler.deregisterMedia(ctx, rt, a.ConnectionID); err != nil {
		t.Fatal(err)
	}
	rt, err = testHandler.Queries.GetAgentRuntime(ctx, parseUUID(rtID))
	if err != nil {
		t.Fatal(err)
	}
	if rt.Status != "online" {
		t.Fatal("stopping A took live profile B offline")
	}
	empty := &protocol.MediaExecutorReport{ConnectionID: a.ConnectionID, Executors: []protocol.MediaExecutorDescriptor{}}
	if err := saveFixtureMedia(t, rtID, empty, false); err != nil {
		t.Fatal(err)
	}
	rows, err := testHandler.Queries.ListMediaExecutors(ctx, db.ListMediaExecutorsParams{WorkspaceID: parseUUID(testWorkspaceID), RuntimeID: parseUUID(rtID)})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if uuidToString(row.ExecutorID) == b.Executors[0].ExecutorID && row.Readiness != "ready" {
			t.Fatal("profile A revoked B")
		}
	}
	dbfx.Exec(t, "UPDATE media_executor SET connection_expires_at=now()-interval '1 second' WHERE executor_id=$1", a.Executors[0].ExecutorID)
	if err := saveFixtureMedia(t, rtID, &foreign, true); err != nil {
		t.Fatalf("expired connection cannot recover: %v", err)
	}
	if err := saveFixtureMedia(t, rtID, a, false); err == nil {
		t.Fatal("retired connection can still renew")
	}
}
func TestMediaQuotaAndPrivateRuntimeBoundaries(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	rtID := dbfx.Runtime(t, "private media", testutil.Cols{"provider": "media", "daemon_id": uuid.NewString(), "visibility": "private", "owner_id": testUserID, "last_seen_at": time.Now(), "status": "online"})
	defer dbfx.Exec(t, "DELETE FROM media_executor WHERE runtime_id=$1", rtID)
	a, b := fixtureMediaReport(), fixtureMediaReport()
	usedA, usedB := 10.0, 65.0
	for i, r := range []*protocol.MediaExecutorReport{a, b} {
		used := &usedA
		if i == 1 {
			used = &usedB
		}
		r.Executors[0].QuotaRef.Windows = []protocol.MediaQuotaWindowRef{{Name: "media"}}
		r.Executors[0].PlanQuota = &protocol.RuntimePlanQuota{Provider: "codex", ObservedAt: time.Now().Unix(), Windows: []protocol.RuntimePlanQuotaWindow{{Name: "media", UsedPercent: used}}}
		if err := saveFixtureMedia(t, rtID, r, true); err != nil {
			t.Fatal(err)
		}
	}
	a.Executors[0].PlanQuota.ObservedAt -= 10
	zero := 0.0
	a.Executors[0].PlanQuota.Windows[0].UsedPercent = &zero
	if err := saveFixtureMedia(t, rtID, a, false); err != nil {
		t.Fatal(err)
	}
	rows, err := testHandler.Queries.ListMediaExecutors(context.Background(), db.ListMediaExecutorsParams{WorkspaceID: parseUUID(testWorkspaceID), RuntimeID: parseUUID(rtID)})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		var q protocol.RuntimePlanQuota
		if err := json.Unmarshal(row.PlanQuota, &q); err != nil {
			t.Fatal(err)
		}
		want := usedA
		if uuidToString(row.ExecutorID) == b.Executors[0].ExecutorID {
			want = usedB
		}
		if *q.Windows[0].UsedPercent != want {
			t.Fatal("stale quota overwrote newer observation or another profile")
		}
	}
	other := dbfx.User(t, "media other", uuid.NewString()+"@example.com")
	dbfx.Member(t, testWorkspaceID, other, "admin")
	list := func(user string) int {
		t.Helper()
		rows, err := testHandler.Queries.ListUsableMediaExecutors(context.Background(), db.ListUsableMediaExecutorsParams{WorkspaceID: parseUUID(testWorkspaceID), UserID: parseUUID(user), Capability: protocol.MediaImageCodexV1})
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, r := range rows {
			if uuidToString(r.RuntimeID) == rtID {
				n++
			}
		}
		return n
	}
	if list(testUserID) != 2 || list(other) != 0 {
		t.Fatal("private runtime consent bypassed")
	}
	dbfx.Exec(t, "UPDATE agent_runtime SET shared_with=$2 WHERE id=$1", rtID, []pgtype.UUID{parseUUID(other)})
	if list(other) != 2 {
		t.Fatal("explicit sharing not honored")
	}
	if canUseRuntimeForAgent(db.Member{UserID: parseUUID(testUserID)}, db.AgentRuntime{Provider: "media", OwnerID: parseUUID(testUserID), Visibility: "public"}) {
		t.Fatal("media runtime can bind an agent")
	}
}
