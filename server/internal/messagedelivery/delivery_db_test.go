package messagedelivery

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var (
	testPool  *pgxpool.Pool
	testFx    *testutil.Fixture
	testWSID  string
	testUID   string
	testAgent string
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		fmt.Printf("Skipping tests: could not connect to database: %v\n", err)
		os.Exit(0)
	}
	if err := pool.Ping(ctx); err != nil {
		fmt.Printf("Skipping tests: database not reachable: %v\n", err)
		pool.Close()
		os.Exit(0)
	}
	testPool = pool

	suffix := time.Now().UnixNano()
	testWSID = mustInsert(`INSERT INTO workspace (id, name, slug, description, issue_prefix)
		VALUES (gen_random_uuid(), $1, $2, '', 'MD') RETURNING id`,
		fmt.Sprintf("md-test-%d", suffix), fmt.Sprintf("md-test-%d", suffix))
	testUID = mustInsert(`INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
		fmt.Sprintf("md-test-%d", suffix), fmt.Sprintf("md-test-%d@multica.ai", suffix))
	mustInsert(`INSERT INTO member (workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'owner') RETURNING id`,
		testWSID, testUID)
	testAgent = mustInsert(`INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config,
			visibility, permission_mode, max_concurrent_tasks, owner_id, instructions, custom_env, custom_args, mcp_config)
		VALUES ($1::uuid, 'md-test-agent', '', 'cloud', '{}'::jsonb, 'private', 'private', 1, $2::uuid, '', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)
		RETURNING id`,
		testWSID, testUID)

	testFx = testutil.New(pool, testWSID, testUID)

	code := m.Run()
	// No FKs: children were registered with t.Cleanup on their own tests;
	// the suite-level teardown below sweeps everything else this suite's
	// workspace may still hold (member/agent included — the schema keeps
	// no cascades, so each sweep is explicit). Each statement carries its
	// OWN argument list and a cleanup ERROR FAILS THE RUN (repair contract
	// S2): leftover rows and swallowed exec errors have already masked real
	// results once.
	cleanups := []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM labrastro_message_receipt WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM labrastro_message_delivery WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM labrastro_message_route WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM labrastro_message_approved_target WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM channel_user_binding WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM channel_installation WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM autopilot_run WHERE autopilot_id IN (SELECT id FROM autopilot WHERE workspace_id = $1)`, []any{testWSID}},
		{`DELETE FROM autopilot WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM agent_task_queue WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = $1)`, []any{testWSID}},
		{`DELETE FROM member WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM agent WHERE workspace_id = $1`, []any{testWSID}},
		{`DELETE FROM workspace WHERE id = $1`, []any{testWSID}},
		{`DELETE FROM "user" WHERE id = $1`, []any{testUID}},
	}
	for _, c := range cleanups {
		if _, err := testPool.Exec(context.Background(), c.sql, c.args...); err != nil {
			fmt.Printf("SUITE CLEANUP FAILED (test result is NOT trustworthy): %v\nSQL: %s\n", err, c.sql)
			code = 1
		}
	}
	pool.Close()
	os.Exit(code)
}

// resetScanCursor deletes a scanner's persisted cursor before AND after a
// test: the cursor table is global state shared across tests and suite runs,
// so a stale position would silently hide candidates from the scan.
func resetScanCursor(t *testing.T, scanner string) {
	t.Helper()
	testFx.Exec(t, `DELETE FROM labrastro_message_scan_cursor WHERE scanner = $1`, scanner)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM labrastro_message_scan_cursor WHERE scanner = $1`, scanner)
	})
}

// mustInsert runs one RETURNING id statement during suite setup.
func mustInsert(sql string, args ...any) string {
	var id string
	if err := testPool.QueryRow(context.Background(), sql, args...).Scan(&id); err != nil {
		if err == pgx.ErrNoRows {
			return ""
		}
		panic(fmt.Sprintf("setup: %v\nSQL: %s", err, strings.TrimSpace(sql)))
	}
	return id
}

// ---- fakes ----

type fakeSender struct {
	mu    sync.Mutex
	calls []SendRequest
	fn    func(req SendRequest) (SendResult, error)
}

func (f *fakeSender) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	f.mu.Lock()
	f.calls = append(f.calls, req)
	fn := f.fn
	f.mu.Unlock()
	if fn == nil {
		return SendResult{ExternalMessageID: "om_fake_" + req.SendUUID[:8]}, nil
	}
	return fn(req)
}

func (f *fakeSender) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeSender) requests() []SendRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]SendRequest, len(f.calls))
	copy(out, f.calls)
	return out
}

type fakeSyncer struct {
	mu          sync.Mutex
	tasks       []db.AgentTaskQueue
	issues      []db.Issue
	linkedTasks []db.AgentTaskQueue
}

func (f *fakeSyncer) SyncRunFromTask(ctx context.Context, task db.AgentTaskQueue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tasks = append(f.tasks, task)
}

func (f *fakeSyncer) SyncRunFromIssue(ctx context.Context, issue db.Issue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issues = append(f.issues, issue)
}

func (f *fakeSyncer) SyncRunFromLinkedIssueTask(ctx context.Context, task db.AgentTaskQueue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.linkedTasks = append(f.linkedTasks, task)
}

// ---- fixtures ----

type mdFixture struct {
	autopilot string
	install   string
}

// newMDFixture builds an active feishu installation and an active autopilot
// (run_only by default).
func newMDFixture(t *testing.T, label string, autopilotOver testutil.Cols) mdFixture {
	t.Helper()
	install := testFx.Insert(t, "channel_installation", testutil.Cols{
		"workspace_id":      testWSID,
		"agent_id":          testAgent,
		"channel_type":      "feishu",
		"config":            testutil.Raw(fmt.Sprintf(`'{"app_id":"cli_md_%d"}'::jsonb`, time.Now().UnixNano())),
		"status":            "active",
		"installer_user_id": testUID,
	})
	autopilot := testFx.Insert(t, "autopilot", mergeCols(testutil.Cols{
		"workspace_id":    testWSID,
		"title":           "MD " + label,
		"assignee_id":     testAgent,
		"status":          "active",
		"execution_mode":  "run_only",
		"created_by_type": "member",
		"created_by_id":   testUID,
	}, autopilotOver))
	// Rows the SERVICE creates (decisions, receipts) are invisible to
	// testFx's own cleanup — sweep them by autopilot at test end so the
	// shared queue never leaks rows between tests or runs.
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM labrastro_message_receipt WHERE delivery_id IN
			(SELECT id FROM labrastro_message_delivery WHERE autopilot_id = $1::uuid)`, autopilot)
		testPool.Exec(ctx, `DELETE FROM labrastro_message_delivery WHERE autopilot_id = $1::uuid`, autopilot)
		testPool.Exec(ctx, `DELETE FROM labrastro_message_route WHERE autopilot_id = $1::uuid`, autopilot)
	})
	return mdFixture{autopilot: autopilot, install: install}
}

func (f mdFixture) bindMember(t *testing.T, userID, openID string) string {
	t.Helper()
	return testFx.Insert(t, "channel_user_binding", testutil.Cols{
		"workspace_id":    testWSID,
		"multica_user_id": userID,
		"installation_id": f.install,
		"channel_type":    "feishu",
		"channel_user_id": openID,
	})
}

func (f mdFixture) memberTargetRoute(t *testing.T, label, userID string, over testutil.Cols) string {
	t.Helper()
	return testFx.Insert(t, "labrastro_message_route", mergeCols(testutil.Cols{
		"id":              testutil.Raw("gen_random_uuid()"),
		"workspace_id":    testWSID,
		"autopilot_id":    f.autopilot,
		"installation_id": f.install,
		"channel_type":    "feishu",
		"target_type":     "member",
		"target_user_id":  userID,
		"target_key":      TargetKey(TargetMember, userID, "", ""),
		"conditions":      ConditionSuccess,
		"content_mode":    ContentWithOutput,
		"enabled":         true,
		"created_by":      testUID,
		"updated_by":      testUID,
	}, over))
}

// approveGroup inserts an active admin approval for a group target — the
// workspace consent the send-time authorization now requires.
func (f mdFixture) approveGroup(t *testing.T, chatID string) {
	t.Helper()
	testFx.Insert(t, "labrastro_message_approved_target", testutil.Cols{
		"workspace_id":    testWSID,
		"autopilot_id":    f.autopilot,
		"installation_id": f.install,
		"target_key":      TargetKey(TargetGroup, "", chatID, ""),
		"target_type":     TargetGroup,
		"approved_by":     testUID,
	})
}

func (f mdFixture) approveTopic(t *testing.T, chatID, messageID string) {
	t.Helper()
	testFx.Insert(t, "labrastro_message_approved_target", testutil.Cols{
		"workspace_id":    testWSID,
		"autopilot_id":    f.autopilot,
		"installation_id": f.install,
		"target_key":      TargetKey(TargetTopic, "", chatID, messageID),
		"target_type":     TargetTopic,
		"approved_by":     testUID,
	})
}

func (f mdFixture) groupRoute(t *testing.T, chatID string) string {
	t.Helper()
	f.approveGroup(t, chatID)
	return testFx.Insert(t, "labrastro_message_route", testutil.Cols{
		"id":              testutil.Raw("gen_random_uuid()"),
		"workspace_id":    testWSID,
		"autopilot_id":    f.autopilot,
		"installation_id": f.install,
		"channel_type":    "feishu",
		"target_type":     "group",
		"target_chat_id":  chatID,
		"target_key":      TargetKey(TargetGroup, "", chatID, ""),
		"conditions":      ConditionSuccess,
		"content_mode":    ContentSummary,
		"enabled":         true,
		"created_by":      testUID,
		"updated_by":      testUID,
	})
}

func (f mdFixture) run(t *testing.T, status string, over testutil.Cols) string {
	t.Helper()
	return testFx.Insert(t, "autopilot_run", mergeCols(testutil.Cols{
		"autopilot_id": f.autopilot,
		"source":       "schedule",
		"status":       status,
		"result":       testutil.Raw(`'{"output":"the report","session_id":"sess_dont_leak"}'::jsonb`),
		"completed_at": testutil.Raw("now()"),
	}, over))
}

// terminalRunDelivery inserts a raw delivery row for worker-path tests
// (queued unless the test says otherwise).
func (f mdFixture) terminalRunDelivery(t *testing.T, status string, over testutil.Cols) string {
	t.Helper()
	run := f.run(t, "completed", nil)
	return testFx.Insert(t, "labrastro_message_delivery", mergeCols(testutil.Cols{
		"id":               testutil.Raw("gen_random_uuid()"),
		"workspace_id":     testWSID,
		"autopilot_id":     f.autopilot,
		"run_id":           run,
		"dedup_key":        fmt.Sprintf("run:%s:%s:t", run, f.install),
		"source_kind":      SourceKindRunOnly,
		"status":           status,
		"content_snapshot": testutil.Raw(`'{"text":"body text","summary":"body","run_status":"completed","has_output":true}'::jsonb`),
		"target_snapshot": testutil.Raw(fmt.Sprintf(
			`'{"target_type":"member","channel_type":"feishu","installation_id":"%s","user_id":"%s"}'::jsonb`, f.install, testUID)),
		"installation_id": f.install,
		"target_key":      "t",
	}, over))
}

func mergeCols(base testutil.Cols, over testutil.Cols) testutil.Cols {
	out := testutil.Cols{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		out[k] = v
	}
	return out
}

func newTestService(sender Sender, syncer RunSyncer) *Service {
	svc := New(db.New(testPool))
	svc.Tx = testPool
	svc.Sender = sender
	svc.Syncer = syncer
	svc.Verifier = &fakeVerifier{}
	svc.AppURL = "https://app.example.com"
	return svc
}

// fakeVerifier proves whatever the route declares, so DB tests can save
// group/topic routes without a transport; tests of the verifier itself
// swap it out.
type fakeVerifier struct {
	groupErr   error
	topicErr   error
	topicChat  string // defaults to echoing the declared chat
	sawTopicID string
}

func (f *fakeVerifier) VerifyGroupTarget(ctx context.Context, req VerifyTargetRequest) error {
	return f.groupErr
}

func (f *fakeVerifier) VerifyTopicTarget(ctx context.Context, req VerifyTargetRequest) (string, error) {
	f.sawTopicID = req.MessageID
	if f.topicErr != nil {
		return "", f.topicErr
	}
	if f.topicChat != "" && f.topicChat != req.ChatID {
		// Like the real adapter: the anchor provably lives elsewhere.
		return "", fmt.Errorf("%w: anchor %s lives in chat %s, not declared %s",
			ErrTargetAnchorMismatch, req.MessageID, f.topicChat, req.ChatID)
	}
	if f.topicChat != "" {
		return f.topicChat, nil
	}
	return req.ChatID, nil
}

// deliveryStatus reads one delivery's lifecycle columns for assertions.
func deliveryStatus(t testing.TB, id string) (status string, attempts int32, errorCode, lastError string) {
	t.Helper()
	if err := testPool.QueryRow(context.Background(),
		`SELECT status, attempts, COALESCE(error_code, ''), COALESCE(last_error, '') FROM labrastro_message_delivery WHERE id = $1`, id,
	).Scan(&status, &attempts, &errorCode, &lastError); err != nil {
		t.Fatalf("load delivery %s: %v", id, err)
	}
	return status, attempts, errorCode, lastError
}

func countDeliveries(t testing.TB, where string, args ...any) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM labrastro_message_delivery WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	return n
}

func countReceipts(t testing.TB, deliveryID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM labrastro_message_receipt WHERE delivery_id = $1`, deliveryID).Scan(&n); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	return n
}

// secondMember gives tests a non-owner member to target, built through the
// shared fixtures so both rows are cleaned up with the test.
func secondMember(t *testing.T, label string) string {
	t.Helper()
	suffix := time.Now().UnixNano()
	userID := testFx.User(t, label, fmt.Sprintf("%s-%d@multica.ai", label, suffix))
	testFx.Member(t, testWSID, userID, "member")
	return userID
}
