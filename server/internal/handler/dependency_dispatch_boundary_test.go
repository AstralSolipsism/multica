package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type dependencyPausedCommit struct {
	service.TxStarter
	ready   chan int
	release chan struct{}
}

type dependencyPausedTx struct {
	pgx.Tx
	pause *dependencyPausedCommit
	pid   int
}

func (p *dependencyPausedCommit) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := p.TxStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	var pid int
	if err = tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return &dependencyPausedTx{Tx: tx, pause: p, pid: pid}, nil
}

func (tx *dependencyPausedTx) Commit(ctx context.Context) error {
	tx.pause.ready <- tx.pid
	select {
	case <-tx.pause.release:
		return tx.Tx.Commit(ctx)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestDependencyClaimCommitsBeforeLaterStatusMutation(t *testing.T) {
	h, fx, a, b, c, agent, runtime := dispatchFixture(t)
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id IN ($1,$2)", a, c)
	id := fx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "issue_id": b})
	pause := &dependencyPausedCommit{TxStarter: testPool, ready: make(chan int, 1), release: make(chan struct{})}
	defer close(pause.release)
	svc := service.NewTaskService(h.Queries, pause, nil, h.TaskService.Bus)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	claimed := make(chan error, 1)
	go func() {
		task, err := svc.ClaimTask(ctx, parseUUID(agent))
		if err == nil && (task == nil || uuidToString(task.ID) != id) {
			err = errors.New("wrong admitted row")
		}
		claimed <- err
	}()
	var pid int
	select {
	case pid = <-pause.ready:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	mutated := make(chan error, 1)
	go func() {
		_, err := testPool.Exec(ctx, "UPDATE issue SET status='todo',revision=revision+1 WHERE id=$1", a)
		mutated <- err
	}()
	waiting := false
	for ctx.Err() == nil {
		if err := testPool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))", pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-mutated:
			t.Fatalf("status mutation bypassed the admission lock: %v", err)
		case <-time.After(time.Millisecond):
		}
	}
	if !waiting {
		t.Fatal("status writer did not overlap the claim transaction")
	}
	pause.release <- struct{}{}
	if err := <-claimed; err != nil {
		t.Fatal(err)
	}
	if err := <-mutated; err != nil {
		t.Fatal(err)
	}
	row, err := h.Queries.GetAgentTask(ctx, parseUUID(id))
	if err != nil {
		t.Fatal(err)
	}
	if row.Status != "dispatched" || len(row.DependencyAdmission) == 0 {
		t.Fatal("later prerequisite change undid an admitted execution")
	}
}

func TestDependencyConfirmationUsesAuthenticatedCredential(t *testing.T) {
	for _, kind := range []string{"task", "pat", "jwt"} {
		t.Run(kind, func(t *testing.T) {
			h, fx, _, b, _, agent, runtime := dispatchFixture(t)
			mutation := map[string]any{"status": "todo", "assignee_type": "agent", "assignee_id": agent}
			mutation["dependency_override"] = dependencyConfirmation(t, h, fx, b, mutation, false)
			token := "mul_" + fx.WorkspaceID
			switch kind {
			case "task":
				token = "mat_" + fx.WorkspaceID
				task := fx.Task(t, agent, testutil.Cols{"issue_id": b, "runtime_id": runtime, "status": "completed"})
				fx.Insert(t, "task_token", testutil.Cols{"token_hash": auth.HashToken(token), "task_id": task, "agent_id": agent, "workspace_id": fx.WorkspaceID, "user_id": fx.UserID, "expires_at": time.Now().Add(time.Hour)})
			case "pat":
				fx.Insert(t, "personal_access_token", testutil.Cols{"user_id": fx.UserID, "name": "dependency auth fixture", "token_hash": auth.HashToken(token), "token_prefix": "mul_test", "expires_at": time.Now().Add(time.Hour)})
			case "jwt":
				var err error
				token, err = jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": fx.UserID, "email": "fixture@example.test", "exp": time.Now().Add(time.Hour).Unix()}).SignedString(auth.JWTSecret())
				if err != nil {
					t.Fatal(err)
				}
			}
			r := dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("X-Actor-Source", "member")
			r.Header.Set("X-Agent-ID", agent)
			r.Header.Set("X-Task-ID", b)
			want := http.StatusForbidden
			if kind == "jwt" {
				want = http.StatusOK
			}
			wrapped := middleware.Auth(h.Queries, nil, nil)(http.HandlerFunc(h.UpdateIssueWithDependencies))
			res := testutil.Call(t, wrapped.ServeHTTP, r).Want(want)
			if kind != "jwt" {
				var body map[string]any
				res.JSON(&body)
				if body["reason_code"] != "dependency_override_not_allowed" {
					t.Fatalf("wrong auth refusal: %v", body)
				}
			}
		})
	}
}

func TestDependencyQueueFailureRollsBackCompoundMutation(t *testing.T) {
	h, fx, a, b, c, agent, _ := dispatchFixture(t)
	d := dependencyIssue(t, fx, "additional prerequisite")
	before, _ := h.Queries.GetIssue(context.Background(), parseUUID(b))
	view := dependencies(t, h, fx, b)
	mutation := map[string]any{"title": "must roll back", "status": "todo", "assignee_type": "agent", "assignee_id": agent, "blocked_by": []string{a, c, d}, "expected_dependency_version": view.DependencyVersion}
	mutation["dependency_override"] = dependencyConfirmation(t, h, fx, b, mutation, false)
	name := "dep_queue_" + strings.ReplaceAll(b, "-", "")
	fx.Exec(t, "CREATE FUNCTION "+name+"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.issue_id='"+b+"'::uuid THEN RAISE EXCEPTION 'fixture queue failure'; END IF; RETURN NEW; END $$")
	fx.Exec(t, "CREATE TRIGGER "+name+" BEFORE INSERT ON agent_task_queue FOR EACH ROW EXECUTE FUNCTION "+name+"()")
	t.Cleanup(func() {
		fx.Exec(t, "DROP TRIGGER "+name+" ON agent_task_queue")
		fx.Exec(t, "DROP FUNCTION "+name+"()")
	})
	var auditsBefore, auditsAfter int
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency_audit WHERE issue_id=$1", b).Scan(&auditsBefore)
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusInternalServerError)
	after, _ := h.Queries.GetIssue(context.Background(), parseUUID(b))
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency_audit WHERE issue_id=$1", b).Scan(&auditsAfter)
	if after.Title != before.Title || after.Status != before.Status || after.AssigneeID != before.AssigneeID || after.Revision != before.Revision || auditsBefore != auditsAfter || dependencies(t, h, fx, b).DependencyVersion != view.DependencyVersion {
		t.Fatal("queue failure leaked an issue, relation, revision or audit mutation")
	}
}

func TestDependencyExpiredChallengeCannotMutate(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"status": "todo", "assignee_type": "agent", "assignee_id": agent}
	confirmation := dependencyConfirmation(t, h, fx, b, mutation, false)
	parts := strings.Split(confirmation.Challenge, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	claims["expires_at"] = "2000-01-01T00:00:00Z"
	raw, _ = json.Marshal(claims)
	mac := hmac.New(sha256.New, h.IssueService.Dependencies.SigningKey)
	mac.Write([]byte("issue-dependency-confirmation-v1\x00"))
	mac.Write(raw)
	confirmation.Challenge = base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	mutation["dependency_override"] = confirmation
	var body map[string]any
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, mutation, "jwt")).Want(http.StatusConflict).JSON(&body)
	if body["reason_code"] != "dependency_override_expired" {
		t.Fatalf("wrong expiry response: %v", body)
	}
}

func TestDependencyDeletedCreateCannotReplay(t *testing.T) {
	h, fx, a, _, _, agent, _ := dispatchFixture(t)
	mutation := map[string]any{"title": "confirmed create", "workspace_id": fx.WorkspaceID, "status": "todo", "assignee_type": "agent", "assignee_id": agent, "blocked_by": []string{a}}
	mutation["dependency_override"] = dependencyConfirmation(t, h, fx, "", mutation, true)
	var created IssueResponse
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", mutation, "jwt")).Want(http.StatusCreated).JSON(&created)
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, created.ID, nil, "jwt")).Want(http.StatusNoContent)
	var body map[string]any
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", mutation, "jwt")).Want(http.StatusConflict).JSON(&body)
	if body["reason_code"] != "dependency_override_stale" {
		t.Fatalf("deleted confirmation resurrected a run: %v", body)
	}
}

func TestDependencyCommentPreviewMatchesDispatch(t *testing.T) {
	h, fx, _, b, _, agent, _ := dispatchFixture(t)
	var preview CommentTriggerPreviewResponse
	testutil.Call(t, h.PreviewCommentTriggers, dependencyRequest(fx, http.MethodPost, b, map[string]any{"content": "[@agent](mention://agent/" + agent + ")"}, "jwt")).Want(http.StatusOK).JSON(&preview)
	if len(preview.Agents) != 0 || len(preview.Blocked) != 1 || preview.Blocked[0].ReasonCode != "dependency_unsatisfied" {
		t.Fatalf("preview disagrees with dispatch: %+v", preview)
	}
}

func TestDependencyLegacyRecoveryChecksBeforeDelivery(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "runtime", true: "machine"}[batch], func(t *testing.T) {
			h, fx, _, b, _, agent, runtime := dispatchFixture(t)
			stale := fx.Task(t, agent, testutil.Cols{"issue_id": b, "runtime_id": runtime, "status": "dispatched", "dispatched_at": testutil.Raw("now()-interval '1 hour'")})
			ready := dependencyIssue(t, fx, "unblocked recovery")
			second := fx.Task(t, agent, testutil.Cols{"issue_id": ready, "runtime_id": runtime, "status": "dispatched", "dispatched_at": testutil.Raw("now()-interval '30 minutes'")})
			var tasks []db.AgentTaskQueue
			var err error
			if batch {
				tasks, err = h.TaskService.ClaimTasksForRuntimes(context.Background(), []pgtype.UUID{parseUUID(runtime)}, 1)
			} else {
				task, e := h.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(runtime))
				err = e
				if task != nil {
					tasks = append(tasks, *task)
				}
			}
			if err != nil || len(tasks) != 1 || uuidToString(tasks[0].ID) != second {
				t.Fatalf("blocked recovery starved the next row: %+v %v", tasks, err)
			}
			row, _ := h.Queries.GetAgentTask(context.Background(), parseUUID(stale))
			if row.Status != "failed" || row.FailureReason.String != "dependency_unsatisfied" {
				t.Fatalf("legacy dispatch bypass: %+v", row)
			}
		})
	}
}

func TestDependencyInheritedQueueClaimAndNullAutopilotBinding(t *testing.T) {
	for _, autopilot := range []bool{false, true} {
		t.Run(map[bool]string{false: "inherited", true: "null_autopilot"}[autopilot], func(t *testing.T) {
			h, fx, _, b, _, agent, runtime := dispatchFixture(t)
			child := dependencyIssue(t, fx, "inherited child", testutil.Cols{"parent_issue_id": b})
			cols := testutil.Cols{"issue_id": child, "runtime_id": runtime}
			if autopilot {
				ap := fx.Insert(t, "autopilot", testutil.Cols{"workspace_id": fx.WorkspaceID, "title": "dependency fixture", "assignee_type": "agent", "assignee_id": agent, "execution_mode": "run_only", "created_by_type": "member", "created_by_id": fx.UserID})
				run := fx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": ap, "issue_id": child, "source": "manual", "status": "running"})
				cols["issue_id"], cols["autopilot_run_id"] = nil, run
			}
			id := fx.Task(t, agent, cols)
			task, err := h.TaskService.ClaimTask(context.Background(), parseUUID(agent))
			if err != nil || task != nil {
				t.Fatalf("inherited prerequisite bypass: %+v %v", task, err)
			}
			row, _ := h.Queries.GetAgentTask(context.Background(), parseUUID(id))
			if row.FailureReason.String != "dependency_unsatisfied" {
				t.Fatalf("missing dependency refusal: %+v", row)
			}
		})
	}
}
