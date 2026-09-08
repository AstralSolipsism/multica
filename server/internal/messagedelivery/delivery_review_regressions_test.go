package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Regression coverage for the OL-25 review (REQUEST_CHANGES on 78dd9c352).
// Each test pins one review finding (R1–R8); the two adaptations versus the
// reviewer's overlay are commented inline where the reviewer's synthetic
// fixture predated the fix it spec exercises.

// R5: one member, two textual UUID spellings, ONE target.
func TestReviewCanonicalMemberTargetDedup(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-canonical", nil)
	fx.bindMember(t, testUID, "ou_review_canonical")
	svc := newTestService(nil, nil)
	ap := loadAutopilot(t, fx.autopilot)
	in := RouteInput{InstallationID: fx.install, TargetType: TargetMember, TargetUserID: testUID,
		Conditions: ConditionSuccess, ContentMode: ContentWithOutput}
	if _, err := svc.CreateRoute(ctx, ap, loadMember(t), in); err != nil {
		t.Fatal(err)
	}
	in.TargetUserID = strings.ToUpper(testUID)
	if _, err := svc.CreateRoute(ctx, ap, loadMember(t), in); !errors.Is(err, ErrRouteAlreadyExists) {
		t.Fatalf("second spelling saved (%v); the canonical key must collapse it", err)
	}
	run := fx.run(t, "completed", nil)
	n, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("same member UUID in different cases produced %d decisions; want 1", n)
	}
}

// R9: a worker whose lease expired mid-flight must not start new sends.
func TestReviewExpiredWorkerCannotStartSend(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-expired-worker", nil)
	fx.bindMember(t, testUID, "ou_review_expired")
	fx.memberTargetRoute(t, "expired", testUID, nil)
	run := fx.run(t, "completed", nil)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	deliveryID := firstDeliveryForRun(t, run)
	claim, err := svc.Queries.ClaimDueLabrastroMessageDelivery(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !uuidEqual(claim.ID, deliveryID) {
		t.Fatal("isolated queue contained an unexpected delivery")
	}
	// The claimed worker pauses. Another replica expires its lease.
	testFx.Exec(t, `UPDATE labrastro_message_delivery SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, deliveryID)
	if err := svc.ScanOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if status, _, _, _ := deliveryStatus(t, deliveryID); status != DeliveryStatusUncertain {
		t.Fatalf("setup status=%s", status)
	}
	// The original worker resumes with its now-invalid claim.
	svc.processClaimed(ctx, claim)
	if sender.count() != 0 {
		t.Fatalf("expired worker made %d new external sends after lease revocation; want 0", sender.count())
	}
}

// R2: a rule stops delivering when its authorizing member loses write on
// the source automation.
func TestReviewDepartedRouteAuthorCannotContinueDelivery(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-departed-author", nil)
	writer := testFx.User(t, "review writer", fmt.Sprintf("review-writer-%s@example.invalid", fx.autopilot))
	memberID := testFx.Member(t, testWSID, writer, "member")
	testFx.InsertNoID(t, "autopilot_collaborator", testutil.Cols{
		"autopilot_id": fx.autopilot, "user_type": "member", "user_id": writer, "granted_by": testUID,
	}, "autopilot_id = $1 AND user_id = $2", fx.autopilot, writer)
	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	ap := loadAutopilot(t, fx.autopilot)
	allowed, err := svc.Queries.IsAutopilotCollaborator(ctx, db.IsAutopilotCollaboratorParams{AutopilotID: ap.ID, UserID: uuidOf(t, writer)})
	if err != nil || !allowed {
		t.Fatalf("initial writer authorization: %v %v", allowed, err)
	}
	fx.approveGroup(t, "oc_review_departed_author")
	if _, err := svc.CreateRoute(ctx, ap, db.Member{UserID: uuidOf(t, writer), Role: "member"}, RouteInput{
		InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: "oc_review_departed_author",
		Conditions: ConditionSuccess, ContentMode: ContentWithOutput,
	}); err != nil {
		t.Fatal(err)
	}
	// Remove the grant and the member, as the workspace-revoke flow does.
	testFx.Exec(t, `DELETE FROM autopilot_collaborator WHERE autopilot_id = $1 AND user_id = $2`, fx.autopilot, writer)
	testFx.Exec(t, `DELETE FROM member WHERE id = $1`, memberID)
	run := fx.run(t, "completed", nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProcessNext(ctx); err != nil {
		t.Fatal(err)
	}
	if sender.count() != 0 {
		t.Fatalf("route authored by removed member still made %d external sends", sender.count())
	}
	status, _, errorCode, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if status != DeliveryStatusCancelled || errorCode != ErrorCodeAuthorizationLost {
		t.Fatalf("status=%s code=%s, want cancelled/route_authorization_lost", status, errorCode)
	}
}

// R7: the source kind comes from the run's persisted links. Adaptation
// versus the overlay: a real run_only run ALWAYS carries its task link
// (dispatchRunOnly sets it), so the fixture pins that link, which is the
// signal the fix reads.
func TestReviewExecutionModeComesFromOriginalRun(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-mode-version", nil)
	fx.bindMember(t, testUID, "ou_review_mode")
	fx.memberTargetRoute(t, "mode", testUID, nil)
	task := testFx.Insert(t, "agent_task_queue", testutil.Cols{
		"agent_id":     testAgent,
		"status":       "completed",
		"completed_at": testutil.Raw("now()"),
		"priority":     0,
	})
	run := fx.run(t, "completed", testutil.Cols{
		"task_id":      task,
		"issue_id":     nil,
		"completed_at": testutil.Raw("now()"),
	})
	testFx.Exec(t, `UPDATE autopilot SET execution_mode = 'create_issue' WHERE id = $1`, fx.autopilot)
	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	d, _, err := svc.GetDelivery(ctx, uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil {
		t.Fatal(err)
	}
	if d.SourceKind != SourceKindRunOnly || !strings.Contains(string(d.ContentSnapshot), "the report") {
		t.Fatalf("original run_only result lost after configuration edit: source=%s content=%s", d.SourceKind, d.ContentSnapshot)
	}
}

// R3: a compensator snapshot that races a committed workspace deletion must
// not recreate content-bearing rows in the deleted workspace.
func TestReviewDecisionCannotRecreateDeletedWorkspaceData(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-delete-race", nil)
	ws := testFx.Insert(t, "workspace", testutil.Cols{"name": "review delete race", "slug": "review-delete-" + fx.autopilot, "description": "", "issue_prefix": "RV"})
	testFx.Exec(t, `UPDATE autopilot SET workspace_id = $1 WHERE id = $2`, ws, fx.autopilot)
	testFx.Exec(t, `UPDATE channel_installation SET workspace_id = $1 WHERE id = $2`, fx.install, ws)
	routeID := fx.groupRoute(t, "oc_review_delete_race")
	testFx.Exec(t, `UPDATE labrastro_message_route SET workspace_id = $1 WHERE id = $2`, ws, routeID)
	run := fx.run(t, "completed", nil)
	svc := newTestService(nil, nil)
	ap := loadAutopilot(t, fx.autopilot)
	route, err := svc.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{ID: uuidOf(t, routeID), WorkspaceID: uuidOf(t, ws)})
	if err != nil {
		t.Fatal(err)
	}
	// The compensator has read its snapshot. Workspace teardown now commits.
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, table := range []string{"labrastro_message_receipt", "labrastro_message_delivery", "labrastro_message_route", "channel_installation", "autopilot"} {
		if _, err := tx.Exec(ctx, "DELETE FROM "+table+" WHERE workspace_id = $1", ws); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workspace WHERE id = $1`, ws); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	n, err := svc.decideDelivery(ctx, ap, decisionInput{WorkspaceID: ws, AutopilotID: fx.autopilot,
		RunID: run, RunStatus: "completed", ExecutionMode: "run_only", Route: route,
		Run: runFields{Result: []byte(`{"output":"synthetic private report"}`)},
	})
	if err == nil && n != 0 {
		t.Fatalf("stale snapshot recreated %d delivery containing output after workspace deletion committed", n)
	}
	if n := countDeliveries(t, `workspace_id = $1`, ws); n != 0 {
		t.Fatalf("%d deliveries landed in a deleted workspace", n)
	}
}

// R4: the stale-issue scan must paginate past a full page of long-running
// candidates within one pass.
func TestReviewStaleIssueScanReachesPastNonterminalPage(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-fair-scan", testutil.Cols{"execution_mode": "create_issue"})
	for i := 0; i < scanPageLimit; i++ {
		issue := testFx.Issue(t, fmt.Sprintf("review open %d", i), testutil.Cols{
			"status": "in_progress", "origin_type": "autopilot", "updated_at": testutil.Raw("now() - interval '1 day'"),
		})
		fx.run(t, "issue_created", testutil.Cols{"completed_at": nil, "issue_id": issue})
	}
	terminal := testFx.Issue(t, "review missed terminal", testutil.Cols{"status": "done", "origin_type": "autopilot"})
	fx.run(t, "issue_created", testutil.Cols{"completed_at": nil, "issue_id": terminal})
	syncer := &fakeSyncer{}
	svc := newTestService(nil, syncer)
	if err := svc.ScanOnce(ctx); err != nil {
		t.Fatal(err)
	}
	for _, issue := range syncer.issues {
		if uuidEqual(issue.ID, terminal) {
			return
		}
	}
	t.Fatalf("terminal issue never reached syncer in a single paginated pass (%d calls); the full page starved it", len(syncer.issues))
}

// R6: the first-terminal status is the one frozen by the terminal sync, not
// the issue's current status. Adaptation versus the overlay: the overlay
// predated the boundary fix, so the fixture here persists what the FIXED
// SyncRunFromIssue writes (first_terminal_status in run.result); the second
// case pins the explicit degradation for runs without that signal.
func TestReviewFirstTerminalStatusIsFrozen(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-first-terminal", testutil.Cols{"execution_mode": "create_issue"})
	fx.groupRoute(t, "oc_review_first_terminal")
	issue := testFx.Issue(t, "review first terminal", testutil.Cols{"status": "in_review", "origin_type": "autopilot"})
	// What the fixed terminal-sync boundary persists at first terminal.
	run := fx.run(t, "completed", testutil.Cols{
		"issue_id": issue,
		"result":   testutil.Raw(`'{"first_terminal_status":"in_review"}'::jsonb`),
	})
	testFx.Exec(t, `UPDATE issue SET status = 'in_progress' WHERE id = $1`, issue)
	svc := newTestService(nil, nil)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	d, _, err := svc.GetDelivery(ctx, uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, run)))
	if err != nil {
		t.Fatal(err)
	}
	var content contentSnapshot
	if err := json.Unmarshal(d.ContentSnapshot, &content); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content.Text, "in_review") {
		t.Fatalf("first-terminal delivery lost the frozen status: %q", content.Text)
	}
	if strings.Contains(content.Text, "in_progress") {
		t.Fatalf("first-terminal delivery used the current status: %q", content.Text)
	}

	// Degradation: a run whose boundary predates the frozen signal must
	// NOT present the current status as the first terminal one. The issue
	// provably changed AFTER the run completed (updated_at is later), so
	// the current status is unreliable and the card degrades.
	legacyIssue := testFx.Issue(t, "review legacy terminal", testutil.Cols{
		"status": "in_review", "origin_type": "autopilot",
		"updated_at": testutil.Raw("now() - interval '30 minutes'"),
	})
	legacyRun := fx.run(t, "completed", testutil.Cols{
		"issue_id":     legacyIssue,
		"result":       nil,
		"completed_at": testutil.Raw("now() - interval '1 hour'"),
	})
	testFx.Exec(t, `UPDATE labrastro_message_route SET effective_from = now() - interval '2 hours'
		WHERE autopilot_id = $1`, fx.autopilot)
	testFx.Exec(t, `UPDATE issue SET status = 'in_progress' WHERE id = $1`, legacyIssue)
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, legacyRun)); err != nil {
		t.Fatal(err)
	}
	d, _, err = svc.GetDelivery(ctx, uuidOf(t, testWSID), uuidOf(t, fx.autopilot), uuidOf(t, firstDeliveryForRun(t, legacyRun)))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(d.ContentSnapshot, &content); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(content.Text, "in_progress") {
		t.Fatalf("degraded delivery presented the current status as first-terminal: %q", content.Text)
	}
}

// R10: an interrupted test send is recoverable, never stranded.
func TestReviewTestSendInterruptedOutcomeCanRecover(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	fx := newMDFixture(t, "review-test-crash", nil)
	routeID := fx.groupRoute(t, "oc_review_test_crash")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
		// The synthetic remote accepts, but the request disconnects before persistence.
		cancel()
		return SendResult{ExternalMessageID: "om_review_test_crash"}, nil
	}}
	svc := newTestService(sender, nil)
	d, err := svc.TestSend(ctx, loadRoute(t, routeID), loadMember(t))
	if err == nil {
		t.Fatal("expected interrupted outcome persistence")
	}
	if err := svc.ScanOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	row, err := svc.Queries.GetLabrastroMessageDelivery(context.Background(), db.GetLabrastroMessageDeliveryParams{ID: d.ID, WorkspaceID: d.WorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	if row.Status == DeliveryStatusSending && !row.LeaseExpiresAt.Valid {
		t.Fatal("test send stranded in sending with no lease expiry; scanner and manual retry cannot recover it")
	}
}

// ---- R1: save-time and send-time verification ----

func TestReviewExternalTargetsRequireVerification(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-verify", nil)
	ap := loadAutopilot(t, fx.autopilot)
	member := loadMember(t)

	// No verifier wired: group/topic saves fail closed.
	noVerify := newTestService(nil, nil)
	noVerify.Verifier = nil
	in := RouteInput{InstallationID: fx.install, TargetType: TargetGroup, TargetChatID: "oc_anywhere",
		Conditions: ConditionSuccess, ContentMode: ContentSummary}
	var unverifiable *TargetUnverifiableError
	if _, err := noVerify.CreateRoute(ctx, ap, member, in); !errors.As(err, &unverifiable) {
		t.Fatalf("unverifiable deployment saved a group route: %v", err)
	}

	// Bot cannot see the chat: refused with the unreachable error.
	var unreachable *TargetUnreachableError
	blocked := newTestService(nil, nil)
	blocked.Verifier = &fakeVerifier{groupErr: fmt.Errorf("%w: bot not in chat", ErrTargetUnreachable)}
	if _, err := blocked.CreateRoute(ctx, ap, member, in); !errors.As(err, &unreachable) {
		t.Fatalf("unreachable chat saved: %v", err)
	}

	// Topic anchor in a different chat: refused as a mismatch.
	var mismatch *TargetAnchorMismatchError
	mismatched := newTestService(nil, nil)
	mismatched.Verifier = &fakeVerifier{topicChat: "oc_real_chat"}
	topicIn := RouteInput{InstallationID: fx.install, TargetType: TargetTopic,
		TargetChatID: "oc_declared", TargetMessageID: "om_1",
		Conditions: ConditionSuccess, ContentMode: ContentSummary}
	if _, err := mismatched.CreateRoute(ctx, ap, member, topicIn); !errors.As(err, &mismatch) {
		t.Fatalf("mismatched anchor saved: %v", err)
	}

	// A save whose declaration MATCHES the resolved anchor stores the
	// verified chat and the verified identity key — and requires the
	// workspace approval for that verified target.
	fx.approveTopic(t, "oc_real_chat", "om_1")
	honest := newTestService(nil, nil)
	honest.Verifier = &fakeVerifier{topicChat: "oc_real_chat"}
	honestIn := topicIn
	honestIn.TargetChatID = "oc_real_chat"
	if _, err := honest.CreateRoute(ctx, ap, member, honestIn); err != nil {
		t.Fatal(err)
	}
	var routeRow struct {
		TargetChatID string `db:"target_chat_id"`
		TargetKey    string `db:"target_key"`
	}
	if err := testPool.QueryRow(ctx,
		`SELECT target_chat_id, target_key FROM labrastro_message_route WHERE autopilot_id = $1 AND target_type = 'topic'`,
		fx.autopilot).Scan(&routeRow.TargetChatID, &routeRow.TargetKey); err != nil {
		t.Fatal(err)
	}
	if routeRow.TargetChatID != "oc_real_chat" {
		t.Fatalf("route stored declared chat %q, want the VERIFIED %q", routeRow.TargetChatID, "oc_real_chat")
	}
	if routeRow.TargetKey != TargetKey(TargetTopic, "", "oc_real_chat", "om_1") {
		t.Fatalf("topic target key = %q, want the verified-chat identity", routeRow.TargetKey)
	}
}

// R1 send half: the anchor→chat relationship is re-proved before dialing.
func TestReviewSendTimeVerificationRefusesMovedAnchor(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newMDFixture(t, "review-send-verify", nil)
	// Raw fixture insert stands in for a route saved while the anchor was
	// valid; the verifier now reports the anchor living elsewhere.
	testFx.Insert(t, "labrastro_message_route", testutil.Cols{
		"id":                testutil.Raw("gen_random_uuid()"),
		"workspace_id":      testWSID,
		"autopilot_id":      fx.autopilot,
		"installation_id":   fx.install,
		"channel_type":      "feishu",
		"target_type":       "topic",
		"target_chat_id":    "oc_original",
		"target_message_id": "om_moved",
		"target_key":        TargetKey(TargetTopic, "", "oc_original", "om_moved"),
		"conditions":        ConditionSuccess,
		"content_mode":      ContentSummary,
		"enabled":           true,
		"created_by":        testUID,
		"updated_by":        testUID,
	})
	run := fx.run(t, "completed", nil)

	sender := &fakeSender{}
	svc := newTestService(sender, nil)
	// The send-time verifier resolves the anchor to a DIFFERENT chat.
	svc.Verifier = &fakeVerifier{topicChat: "oc_elsewhere"}
	if _, err := svc.EnqueueRunDeliveries(ctx, uuidOf(t, run)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProcessNext(ctx); err != nil {
		t.Fatal(err)
	}
	if sender.count() != 0 {
		t.Fatalf("sent %d messages to a moved anchor; want 0", sender.count())
	}
	status, _, errorCode, _ := deliveryStatus(t, firstDeliveryForRun(t, run))
	if status != DeliveryStatusFailed || errorCode != ErrorCodeTopicAnchorMismatch {
		t.Fatalf("status=%s code=%s, want failed/route_topic_anchor_mismatch", status, errorCode)
	}
}
