package messagedelivery

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestReviewOL27_OverlappingRoutesPreferMatch(t *testing.T) {
	for _, kind := range []string{RouteSourceActivity, RouteSourceComment} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			fx := newSourceFixture(t, "review-overlap-"+kind)
			resetSourceScanCursors(t)
			chat := "oc_review_overlap_" + kind
			fx.approveTeam(t, kind, chat)
			fx.teamRoute(t, "unmatched-first", kind, chat, testutil.Cols{
				"project_id": fx.project,
				"created_at": testutil.Raw("now() - interval '1 second'"),
			})
			fx.teamRoute(t, "matched-second", kind, chat, nil)
			var sourceID string
			if kind == RouteSourceActivity {
				sourceID = fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"in_progress"}`)
			} else {
				sourceID = fx.comment(t, fx.issue, "must reach the matching workspace route")
			}
			s := newTestService(&fakeSender{}, nil)
			if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
				t.Fatal(errs)
			}
			var status string
			testFx.QueryRow(t, `SELECT status FROM labrastro_message_delivery WHERE source_ref_id = $1::uuid`, sourceID).Scan(&status)
			if status != DeliveryStatusQueued {
				t.Fatalf("matching workspace route lost: got %s, want queued", status)
			}
		})
	}
}

func TestReviewOL27_TeamTestSend(t *testing.T) {
	for _, kind := range []string{RouteSourceActivity, RouteSourceComment} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			fx := newSourceFixture(t, "review-testsend-"+kind)
			chat := "oc_review_testsend_" + kind
			fx.approveTeam(t, kind, chat)
			sender := &fakeSender{}
			s := newTestService(sender, nil)
			member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
			route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
				Scope: kind, InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: chat,
			})
			if err != nil {
				t.Fatal(err)
			}
			testFx.Cleanup(t, `DELETE FROM labrastro_message_route WHERE id=$1`, route.ID)
			delivery, err := s.TestSourceSend(ctx, route, member)
			if err != nil {
				t.Fatal(err)
			}
			if delivery.Status != DeliveryStatusSent || sender.count() != 1 {
				t.Fatalf("approved team test send: status=%s code=%s sender_calls=%d, want sent and 1 call", delivery.Status, delivery.ErrorCode.String, sender.count())
			}
		})
	}
}

func TestReviewOL27_TargetEditDoesNotReplay(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "review-target-replay")
	resetSourceScanCursors(t)
	fx.approveTeam(t, RouteSourceActivity, "oc_review_old")
	fx.approveTeam(t, RouteSourceActivity, "oc_review_new")
	s := newTestService(&fakeSender{}, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceActivity, InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: "oc_review_old",
	})
	if err != nil {
		t.Fatal(err)
	}
	testFx.Cleanup(t, `DELETE FROM labrastro_message_route WHERE id=$1`, route.ID)
	sourceID := fx.activity(t, fx.issue, "status_changed", `{"from":"todo","to":"in_progress"}`)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	var deliveryID string
	testFx.QueryRow(t, `SELECT id FROM labrastro_message_delivery WHERE source_ref_id=$1::uuid`, sourceID).Scan(&deliveryID)
	delivery, err := s.Queries.ClaimLabrastroMessageDeliveryByID(ctx, uuidOf(t, deliveryID))
	if err != nil {
		t.Fatal(err)
	}
	s.processClaimed(ctx, delivery)
	status, _, _, _ := deliveryStatus(t, deliveryID)
	if status != DeliveryStatusSent {
		t.Fatalf("initial delivery: %s", status)
	}
	in := sourceRouteInputFromRoute(route)
	in.TargetChatID = "oc_review_new"
	if _, err := s.UpdateSourceRoute(ctx, route, member, route.Revision, in); err != nil {
		t.Fatal(err)
	}
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if got := countSourceDecisions(t, sourceID); got != 1 {
		t.Fatalf("retarget replayed historical event: %d decisions, want 1", got)
	}
}

func TestReviewOL27_FilterEditBeforeFirstScan(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "review-filter-before-scan")
	resetSourceScanCursors(t)
	fx.bindMember(t, testUID, "ou_review_filter")
	s := newTestService(&fakeSender{}, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceInbox, InstallationID: fx.install, TargetType: TargetMember, TargetUserID: testUID,
		EventTypes: []string{"issue_assigned"},
	})
	if err != nil {
		t.Fatal(err)
	}
	testFx.Cleanup(t, `DELETE FROM labrastro_message_route WHERE id=$1`, route.ID)
	sourceID := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	in := sourceRouteInputFromRoute(route)
	in.EventTypes = nil
	if _, err := s.UpdateSourceRoute(ctx, route, member, route.Revision, in); err != nil {
		t.Fatal(err)
	}
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	got := testFx.Count(t, `SELECT count(*) FROM labrastro_message_delivery WHERE source_ref_id=$1::uuid AND status='queued'`, sourceID)
	if got != 0 {
		t.Fatalf("filter edit queued %d pre-edit excluded events, want 0", got)
	}
}

type reviewDeleteProjectVerifier struct {
	callback func()
}

func (v reviewDeleteProjectVerifier) VerifyGroupTarget(context.Context, VerifyTargetRequest) error {
	v.callback()
	return nil
}

func (v reviewDeleteProjectVerifier) VerifyTopicTarget(_ context.Context, req VerifyTargetRequest) (string, error) {
	return req.ChatID, nil
}

func TestReviewOL27_ProjectRemovedDuringVerification(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "review-project-race")
	fx.approveTeam(t, RouteSourceActivity, "oc_review_project_race", fx.project)
	s := newTestService(&fakeSender{}, nil)
	s.Verifier = reviewDeleteProjectVerifier{callback: func() {
		testFx.Exec(t, `DELETE FROM project WHERE id=$1::uuid AND workspace_id=$2::uuid`, fx.project, testWSID)
	}}
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceActivity, InstallationID: fx.install, TargetType: TargetGroup,
		TargetChatID: "oc_review_project_race", ProjectID: fx.project,
	})
	if err == nil {
		testFx.Cleanup(t, `DELETE FROM labrastro_message_route WHERE id=$1`, route.ID)
		t.Fatalf("save succeeded after project deletion: route=%s enabled=%t project=%s", util.UUIDToString(route.ID), route.Enabled, util.UUIDToString(route.ProjectID))
	}
	var invalid *InvalidRouteError
	if !errors.As(err, &invalid) || invalid.Field != "project_id" {
		t.Fatalf("want project refusal, got %v", err)
	}

}

func TestReviewOL27_DisableBetweenCandidateAndInsert(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "review-disable-race")
	fx.bindMember(t, testUID, "ou_review_disable")
	s := newTestService(&fakeSender{}, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceInbox, InstallationID: fx.install, TargetType: TargetMember, TargetUserID: testUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	testFx.Cleanup(t, `DELETE FROM labrastro_message_route WHERE id=$1`, route.ID)
	sourceID := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	rows, err := s.Queries.ListLabrastroMessageInboxSourceCandidates(ctx, db.ListLabrastroMessageInboxSourceCandidatesParams{
		AfterID: scanCursorStart.id, UpperID: uuidOf(t, sourceID), Limit: 200,
	})
	if err != nil {
		t.Fatal(err)
	}
	var candidate db.ListLabrastroMessageInboxSourceCandidatesRow
	for _, row := range rows {
		if row.ItemID == uuidOf(t, sourceID) {
			candidate = row
		}
	}
	if !candidate.ItemID.Valid {
		t.Fatal("candidate not found")
	}
	disabled, err := s.SetSourceRouteEnabled(ctx, route, member, false, route.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.decideInboxPair(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSourceRouteEnabled(ctx, disabled, member, true, disabled.Revision); err != nil {
		t.Fatal(err)
	}
	if countSourceDecisions(t, sourceID) != 0 {
		t.Fatal("stale candidate was committed after disable")
	}
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if countSourceDecisions(t, sourceID) != 0 {
		t.Fatal("re-enable backfilled an old source")
	}
	fresh := fx.inboxItem(t, testUID, "status_changed", fx.issue)
	if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
		t.Fatal(errs)
	}
	if countSourceDecisions(t, fresh) != 1 {
		t.Fatal("re-enabled route lost a fresh source")
	}
}

func TestReviewOL27_RollbackAfterPersonalTestSend(t *testing.T) {
	ctx := context.Background()
	fx := newSourceFixture(t, "review-rollback")
	fx.bindMember(t, testUID, "ou_review_rollback")
	s := newTestService(&fakeSender{}, nil)
	member := db.Member{WorkspaceID: uuidOf(t, testWSID), UserID: uuidOf(t, testUID)}
	route, err := s.CreateSourceRoute(ctx, member, SourceRouteInput{
		Scope: RouteSourceInbox, InstallationID: fx.install, TargetType: TargetMember, TargetUserID: testUID,
	})
	if err != nil {
		t.Fatal(err)
	}
	testFx.Cleanup(t, `DELETE FROM labrastro_message_route WHERE id=$1`, route.ID)
	delivery, err := s.TestSourceSend(ctx, route, member)
	if err != nil {
		t.Fatal(err)
	}
	if delivery.Status != DeliveryStatusSent {
		t.Fatalf("personal test send failed: %s", delivery.Status)
	}
	ddl, err := os.ReadFile("../../migrations/467_labrastro_message_sources.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, string(ddl)); err != nil {
		t.Fatalf("467 down fails after valid personal test-send: %v", err)
	}
}
