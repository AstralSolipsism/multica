package projectfile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type memoryObjects struct {
	mu        sync.Mutex
	data      map[string][]byte
	afterPut  func(context.Context, string) error
	openCount int
}

func (m *memoryObjects) Put(ctx context.Context, key string, reader io.Reader, size int64, _ string) error {
	content, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	m.mu.Lock()
	if m.data == nil {
		m.data = make(map[string][]byte)
	}
	if _, exists := m.data[key]; exists {
		m.mu.Unlock()
		return errors.New("immutable key reused")
	}
	m.data[key] = content
	m.mu.Unlock()
	if m.afterPut != nil {
		return m.afterPut(ctx, key)
	}
	return nil
}

func (m *memoryObjects) Open(_ context.Context, key string) (io.ReadCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.openCount++
	content, ok := m.data[key]
	if !ok {
		return nil, errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(content)), nil
}

type harness struct {
	s       *Service
	pool    *pgxpool.Pool
	fx      *testutil.Fixture
	scope   Scope
	objects *memoryObjects
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	url := os.Getenv("PROJECT_FILE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PROJECT_FILE_TEST_DATABASE_URL must name an isolated migrated test database")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	fx := testutil.New(pool, "", "")
	fx.UserID = fx.User(t, "Project file test", uuid.NewString()+"@example.invalid")
	fx.WorkspaceID = fx.Workspace(t, "Project files", "pf-"+uuid.NewString())
	fx.Member(t, fx.WorkspaceID, fx.UserID, "owner")
	project := fx.Project(t, "Shared resources")
	// The service retains all versions and intents; fixture cleanup is explicitly
	// scoped to this test project, with no shared database/table truncation.
	for _, table := range []string{"project_file", "project_file_version", "project_file_candidate", "project_file_operation", "project_file_upload"} {
		fx.Cleanup(t, "DELETE FROM "+table+" WHERE project_id=$1", project)
	}
	objects := &memoryObjects{}
	return &harness{s: New(db.New(pool), pool, objects, Options{}), pool: pool, fx: fx, objects: objects,
		scope: Scope{WorkspaceID: util.MustParseUUID(fx.WorkspaceID), ProjectID: util.MustParseUUID(project), Identity: auth.Identity{UserID: fx.UserID, CredentialKind: "jwt"}}}
}

func requestFor(path string, base int64, data []byte) Request {
	return Request{Kind: "save", Path: path, BaseRevision: base, SHA256: fmt.Sprintf("%x", sha256.Sum256(data)), SizeBytes: int64(len(data)), ContentType: "application/octet-stream"}
}

func (h *harness) save(t *testing.T, path string, base int64, content string) Result {
	t.Helper()
	data := []byte(content)
	result, err := h.s.Save(context.Background(), h.scope, uuid.NewString(), requestFor(path, base, data), bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func reviewCandidate(t *testing.T) (*harness, Result) {
	t.Helper()
	h := newHarness(t)
	for i, data := range []string{"v1", "v2"} {
		if result := h.save(t, "facts.md", int64(i), data); result.Status != StatusSaved || result.Revision != int64(i+1) {
			t.Fatalf("seed: %+v", result)
		}
	}
	candidate := h.save(t, "facts.md", 1, "candidate content")
	if candidate.Status != StatusConflict || candidate.CandidateID == "" {
		t.Fatalf("candidate: %+v", candidate)
	}
	return h, candidate
}

func adoptRequest(candidate Result, base int64) Request {
	return Request{Kind: "adopt", Path: candidate.Path, BaseRevision: base, CandidateID: candidate.CandidateID}
}

// Ported from the parent issue's review_success_replay_test.go. Compare every
// public field; only Replayed may differ, including for a consumed candidate.
func TestReviewAdoptSuccessReplayComplete(t *testing.T) {
	h, candidate := reviewCandidate(t)
	request := adoptRequest(candidate, 2)
	first, err := h.s.Adopt(context.Background(), h.scope, "adopt", request)
	if err != nil || first.Status != StatusSaved || first.Revision != 3 || first.CandidateID != "" {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	retry, err := h.s.Adopt(context.Background(), h.scope, "adopt", request)
	want := first
	want.Replayed = true
	if err != nil || retry != want {
		t.Fatalf("first=%+v retry=%+v err=%v", first, retry, err)
	}
	op, err := h.s.Operation(context.Background(), h.scope, "adopt")
	if err != nil || op.Result == nil || *op.Result != want {
		t.Fatalf("operation=%+v err=%v", op, err)
	}
	var bound Request
	var raw []byte
	h.fx.QueryRow(t, "SELECT request FROM project_file_operation WHERE project_id=$1 AND operation_key='adopt'", h.scope.ProjectID).Scan(&raw)
	if err = json.Unmarshal(raw, &bound); err != nil || bound.CandidateID != candidate.CandidateID {
		t.Fatalf("binding lost candidate: %+v %v", bound, err)
	}
	if h.objects.openCount != 0 {
		t.Fatal("adoption read object bytes while committing metadata")
	}
}

func TestReviewAdoptConflictReplayStableAndAfterConsumption(t *testing.T) {
	h, candidate := reviewCandidate(t)
	h.save(t, candidate.Path, 2, "v3")
	request := adoptRequest(candidate, 2)
	first, err := h.s.Adopt(context.Background(), h.scope, "stale", request)
	if err != nil || first.Status != StatusConflict || first.Revision != 3 {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	for _, consume := range []bool{false, true} {
		if consume {
			if r, err := h.s.Adopt(context.Background(), h.scope, "fresh", adoptRequest(candidate, 4)); err != nil || r.Status != StatusSaved {
				t.Fatalf("consume: %+v %v", r, err)
			}
		} else {
			h.save(t, candidate.Path, 3, "v4")
		}
		retry, err := h.s.Adopt(context.Background(), h.scope, "stale", request)
		want := first
		want.Replayed = true
		if err != nil || retry != want {
			t.Fatalf("consume=%v retry=%+v want=%+v err=%v", consume, retry, want, err)
		}
	}
	if _, err := h.s.Adopt(context.Background(), h.scope, "stale", adoptRequest(candidate, 3)); !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("changed expected revision: %v", err)
	}
}

func TestReviewCrossOperationKeyRejectedBothDirections(t *testing.T) {
	h, candidate := reviewCandidate(t)
	adopt := adoptRequest(candidate, 2)
	if _, err := h.s.Adopt(context.Background(), h.scope, "adopt", adopt); err != nil {
		t.Fatal(err)
	}
	h.save(t, candidate.Path, 3, "v4")
	data := []byte("candidate content")
	if _, err := h.s.Save(context.Background(), h.scope, "adopt", requestFor(candidate.Path, 2, data), bytes.NewReader(data)); !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("adopt -> save: %v", err)
	}
	if _, err := h.s.Save(context.Background(), h.scope, "save", requestFor("other.bin", 0, data), bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.s.Adopt(context.Background(), h.scope, "save", adopt); !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("save -> adopt: %v", err)
	}
}

func TestSaveBindingAndCompleteReplay(t *testing.T) {
	h := newHarness(t)
	data := []byte("v1")
	request := requestFor("facts.md", 0, data)
	first, err := h.s.Save(context.Background(), h.scope, "original", request, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	h.save(t, request.Path, 1, "v2")
	retry, err := h.s.Save(context.Background(), h.scope, "original", request, bytes.NewReader(data))
	want := first
	want.Replayed = true
	if err != nil || retry != want {
		t.Fatalf("complete replay: %+v %v", retry, err)
	}
	for _, change := range []func(*Request){
		func(r *Request) { r.Path = "other.md" }, func(r *Request) { r.BaseRevision = 1 },
		func(r *Request) { r.ContentType = "text/plain" }, func(r *Request) { r.SizeBytes++ },
		func(r *Request) { r.SHA256 = fmt.Sprintf("%x", sha256.Sum256([]byte("other"))) },
	} {
		changed := request
		change(&changed)
		if _, err := h.s.Save(context.Background(), h.scope, "original", changed, bytes.NewReader(data)); !errors.Is(err, ErrOpKeyReused) {
			t.Fatalf("changed binding: %+v %v", changed, err)
		}
	}
	if _, err := h.s.Save(context.Background(), h.scope, "original", request, bytes.NewReader([]byte("xx"))); !errors.Is(err, ErrContentMismatch) {
		t.Fatalf("forged digest replay: %v", err)
	}
	conflictRequest := requestFor(request.Path, 0, []byte("candidate"))
	conflict, err := h.s.Save(context.Background(), h.scope, "conflict", conflictRequest, bytes.NewReader([]byte("candidate")))
	if err != nil || conflict.Status != StatusConflict {
		t.Fatalf("conflict %+v %v", conflict, err)
	}
	h.save(t, request.Path, 2, "v3")
	retry, err = h.s.Save(context.Background(), h.scope, "conflict", conflictRequest, bytes.NewReader([]byte("candidate")))
	want = conflict
	want.Replayed = true
	if err != nil || retry != want {
		t.Fatalf("conflict replay: %+v %v", retry, err)
	}
}

func TestConcurrentSavesAndDuplicateKeys(t *testing.T) {
	for _, mode := range []string{"different-keys", "same-request", "different-paths"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			arrived, release := make(chan struct{}, 2), make(chan struct{})
			h.objects.afterPut = func(ctx context.Context, _ string) error {
				arrived <- struct{}{}
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			type outcome struct {
				value Result
				err   error
			}
			results := make(chan outcome, 2)
			for i := 0; i < 2; i++ {
				go func(i int) {
					key, path, data := "same", "facts.md", []byte("same")
					if mode == "different-keys" {
						key, data = fmt.Sprint(i), []byte{byte(i), 0, 255}
					}
					if mode == "different-paths" {
						path = fmt.Sprintf("%d.md", i)
					}
					value, err := h.s.Save(ctx, h.scope, key, requestFor(path, 0, data), bytes.NewReader(data))
					results <- outcome{value, err}
				}(i)
			}
			// Different bindings are rejected before upload, so only one should
			// reach storage. Identical operations may upload two independent keys.
			arrivals := 2
			if mode == "different-paths" {
				arrivals = 1
			}
			for i := 0; i < arrivals; i++ {
				select {
				case <-arrived:
				case <-ctx.Done():
					close(release)
					t.Fatal("upload barrier timeout")
				}
			}
			close(release)
			saved, conflicts, replays, rejected := 0, 0, 0, 0
			for i := 0; i < 2; i++ {
				r := <-results
				switch {
				case errors.Is(r.err, ErrOpKeyReused):
					rejected++
				case r.err != nil:
					t.Fatalf("unexpected error: %v", r.err)
				case r.value.Replayed:
					replays++
				case r.value.Status == StatusSaved:
					saved++
				case r.value.Status == StatusConflict:
					conflicts++
				}
			}
			if saved != 1 || (mode == "different-keys" && conflicts != 1) || (mode == "same-request" && replays != 1) || (mode == "different-paths" && rejected != 1) {
				t.Fatalf("saved=%d conflicts=%d replays=%d rejected=%d", saved, conflicts, replays, rejected)
			}
			if n := h.fx.Count(t, "SELECT count(*) FROM project_file WHERE project_id=$1", h.scope.ProjectID); n != 1 {
				t.Fatalf("loser left file: %d", n)
			}
		})
	}
}

func TestConcurrentIdenticalAdoptions(t *testing.T) {
	h, candidate := reviewCandidate(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan Result, 2)
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			r, e := h.s.Adopt(ctx, h.scope, "same", adoptRequest(candidate, 2))
			results <- r
			errs <- e
		}()
	}
	close(start)
	a, b := <-results, <-results
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if a.Replayed == b.Replayed {
		t.Fatalf("one commit and one replay required: %+v %+v", a, b)
	}
	a.Replayed, b.Replayed = false, false
	if a != b || a.Revision != 3 {
		t.Fatalf("different results: %+v %+v", a, b)
	}
}

type commitFault struct {
	*pgxpool.Pool
	count atomic.Int32
	at    int32
	after bool
}
type faultTx struct {
	pgx.Tx
	owner *commitFault
}

func (f *commitFault) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &faultTx{tx, f}, nil
}
func (tx *faultTx) Commit(ctx context.Context) error {
	if tx.owner.count.Add(1) != tx.owner.at {
		return tx.Tx.Commit(ctx)
	}
	if tx.owner.after {
		if err := tx.Tx.Commit(ctx); err != nil {
			return err
		}
	}
	return errors.New("injected lost commit response")
}

func TestUploadAndCommitFailuresRecoverWithoutDuplicateVersions(t *testing.T) {
	for _, failure := range []string{"upload", "before-commit", "after-commit"} {
		t.Run(failure, func(t *testing.T) {
			h := newHarness(t)
			data := []byte("durable")
			req := requestFor("facts.md", 0, data)
			if failure == "upload" {
				h.objects.afterPut = func(context.Context, string) error { return errors.New("lost upload response") }
			} else {
				h.s.beginner = &commitFault{Pool: h.pool, at: 2, after: failure == "after-commit"}
			}
			first, err := h.s.Save(context.Background(), h.scope, "retry", req, bytes.NewReader(data))
			if err == nil || first.Status != "" {
				t.Fatalf("failure reported success: %+v %v", first, err)
			}
			if failure == "upload" && !errors.Is(err, ErrStorage) {
				t.Fatal(err)
			}
			if failure != "upload" && !errors.Is(err, ErrOutcomeUnknown) {
				t.Fatal(err)
			}
			op, err := h.s.Operation(context.Background(), h.scope, "retry")
			wantState := "PENDING"
			if failure == "after-commit" {
				wantState = "COMPLETED"
			}
			if err != nil || op.State != wantState {
				t.Fatalf("operation=%+v %v", op, err)
			}
			h.objects.afterPut = nil
			h.s.beginner = h.pool
			result, err := h.s.Save(context.Background(), h.scope, "retry", req, bytes.NewReader(data))
			if err != nil || result.Status != StatusSaved || result.Revision != 1 || result.Replayed != (failure == "after-commit") {
				t.Fatalf("retry=%+v %v", result, err)
			}
			if n := h.fx.Count(t, "SELECT count(*) FROM project_file_version WHERE project_id=$1", h.scope.ProjectID); n != 1 {
				t.Fatalf("versions=%d", n)
			}
			var key string
			h.fx.QueryRow(t, "SELECT object_key FROM project_file_version WHERE project_id=$1", h.scope.ProjectID).Scan(&key)
			if !bytes.Equal(h.objects.data[key], data) {
				t.Fatal("current points at missing or changed bytes")
			}
		})
	}
}

func (h *harness) run(t *testing.T, chat bool) Scope {
	t.Helper()
	runtimeID := h.fx.Runtime(t, "File runtime")
	agent := h.fx.Agent(t, "File author "+uuid.NewString(), runtimeID)
	cols := testutil.Cols{"status": "running", "runtime_id": runtimeID}
	if chat {
		cols["chat_session_id"] = h.fx.ChatSession(t, agent, testutil.Cols{"project_id": util.UUIDToString(h.scope.ProjectID)})
	} else {
		cols["issue_id"] = h.fx.Issue(t, "Shared resource run", testutil.Cols{"project_id": util.UUIDToString(h.scope.ProjectID)})
	}
	task := h.fx.Task(t, agent, cols)
	token := "mat_" + uuid.NewString()
	h.fx.Insert(t, "task_token", testutil.Cols{"task_id": task, "agent_id": agent, "user_id": h.fx.UserID, "workspace_id": h.fx.WorkspaceID, "token_hash": auth.HashToken(token), "expires_at": time.Now().Add(time.Hour)})
	scope := h.scope
	scope.Identity = auth.Identity{UserID: h.fx.UserID, AgentID: agent, TaskID: task, WorkspaceID: h.fx.WorkspaceID, CredentialKind: "task", CredentialHash: auth.HashToken(token)}
	return scope
}

func TestAuthorizationInvalidatedDuringUpload(t *testing.T) {
	for _, change := range []string{"membership", "token-expiry", "token-revoke", "run-ended", "project-changed", "project-deleted", "agent-archived", "pat-revoke"} {
		t.Run(change, func(t *testing.T) {
			h := newHarness(t)
			scope := h.run(t, false)
			if change == "pat-revoke" {
				scope = h.scope
				scope.Identity.CredentialKind = "pat"
				scope.Identity.CredentialHash = auth.HashToken("mul_test")
				h.fx.Insert(t, "personal_access_token", testutil.Cols{"user_id": h.fx.UserID, "name": "test", "token_hash": scope.Identity.CredentialHash, "token_prefix": "mul_test"})
			}
			h.objects.afterPut = func(ctx context.Context, _ string) error {
				switch change {
				case "membership":
					h.fx.Exec(t, "DELETE FROM member WHERE user_id=$1 AND workspace_id=$2", h.fx.UserID, h.fx.WorkspaceID)
				case "token-expiry":
					h.fx.Exec(t, "UPDATE task_token SET expires_at=clock_timestamp()-interval '1 second' WHERE task_id=$1", scope.Identity.TaskID)
				case "token-revoke":
					h.fx.Exec(t, "DELETE FROM task_token WHERE task_id=$1", scope.Identity.TaskID)
				case "run-ended":
					h.fx.Exec(t, "UPDATE agent_task_queue SET status='completed', completed_at=clock_timestamp() WHERE id=$1", scope.Identity.TaskID)
				case "project-changed":
					h.fx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=(SELECT issue_id FROM agent_task_queue WHERE id=$1)", scope.Identity.TaskID)
				case "project-deleted":
					h.fx.Exec(t, "DELETE FROM project WHERE id=$1", h.scope.ProjectID)
				case "agent-archived":
					h.fx.Exec(t, "UPDATE agent SET archived_at=clock_timestamp() WHERE id=$1", scope.Identity.AgentID)
				case "pat-revoke":
					h.fx.Exec(t, "UPDATE personal_access_token SET revoked=true WHERE user_id=$1", h.fx.UserID)
				}
				return nil
			}
			data := []byte("must remain uncommitted")
			_, err := h.s.Save(context.Background(), scope, "revoked", requestFor("facts.md", 0, data), bytes.NewReader(data))
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("authorization invalidation: %v", err)
			}
			if n := h.fx.Count(t, "SELECT count(*) FROM project_file_version WHERE project_id=$1", h.scope.ProjectID); n != 0 {
				t.Fatalf("unauthorized versions=%d", n)
			}
			if n := h.fx.Count(t, "SELECT count(*) FROM project_file_upload WHERE project_id=$1", h.scope.ProjectID); n != 1 {
				t.Fatalf("upload intent missing: %d", n)
			}
		})
	}
}

func TestRunProjectScopeAttributionAndAllReadEntrypoints(t *testing.T) {
	h := newHarness(t)
	for _, chat := range []bool{false, true} {
		scope := h.run(t, chat)
		data := []byte("by run")
		path := fmt.Sprintf("%v.md", chat)
		result, err := h.s.Save(context.Background(), scope, "run-save", requestFor(path, 0, data), bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		file, body, err := h.s.Read(context.Background(), scope, path, nil)
		if err != nil {
			t.Fatal(err)
		}
		body.Close()
		if file.AuthorType != "agent" || file.AuthorID != scope.Identity.AgentID || file.SourceTaskID != scope.Identity.TaskID {
			t.Fatalf("untrusted author: %+v", file)
		}
		other := scope
		other.ProjectID = util.MustParseUUID(h.fx.Project(t, "Other project"))
		if err := h.s.CheckAccess(context.Background(), other); !errors.Is(err, ErrForbidden) {
			t.Fatalf("cross-project run: %v", err)
		}
		if _, err := h.s.Operation(context.Background(), h.scope, "run-save"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("member read run ledger: %v", err)
		}
		h.fx.Exec(t, "DELETE FROM task_token WHERE task_id=$1", scope.Identity.TaskID)
		checks := []func() error{
			func() error { _, err := h.s.List(context.Background(), scope, "", "", 50); return err },
			func() error {
				_, b, err := h.s.Read(context.Background(), scope, path, nil)
				if b != nil {
					b.Close()
				}
				return err
			},
			func() error { _, err := h.s.Candidates(context.Background(), scope, path, "", 50); return err },
			func() error {
				_, b, err := h.s.ReadCandidate(context.Background(), scope, util.MustParseUUID(result.VersionID))
				if b != nil {
					b.Close()
				}
				return err
			},
			func() error { _, err := h.s.Operation(context.Background(), scope, "run-save"); return err },
			func() error {
				_, err := h.s.Save(context.Background(), scope, "run-save", requestFor(path, 0, data), bytes.NewReader(data))
				return err
			},
			func() error {
				_, err := h.s.Adopt(context.Background(), scope, "adopt", Request{Kind: "adopt", Path: path, BaseRevision: 1, CandidateID: result.VersionID})
				return err
			},
		}
		for i, check := range checks {
			if err := check(); !errors.Is(err, ErrForbidden) {
				t.Fatalf("revoked entry %d: %v", i, err)
			}
		}
	}
}

func TestListIsBoundedLiteralAndMetadataOnly(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"a%/one.md", "a%/two.md", "ab/three.md", "中文/资料.md"} {
		h.save(t, path, 0, "payload")
	}
	first, err := h.s.List(context.Background(), h.scope, "a%/", "", 1)
	if err != nil || len(first.Files) != 1 || first.NextCursor == "" {
		t.Fatalf("first=%+v %v", first, err)
	}
	second, err := h.s.List(context.Background(), h.scope, "a%/", first.NextCursor, 1)
	if err != nil || len(second.Files) != 1 || second.NextCursor != "" || second.Files[0].Path == first.Files[0].Path {
		t.Fatalf("second=%+v %v", second, err)
	}
	if h.objects.openCount != 0 {
		t.Fatal("list fetched content")
	}
	h.save(t, "a%/one.md", 0, "conflict")
	if page, err := h.s.Candidates(context.Background(), h.scope, "a%/one.md", "", 1); err != nil || len(page.Files) != 1 || h.objects.openCount != 0 {
		t.Fatalf("candidates=%+v %v", page, err)
	}
	if _, err := h.s.List(context.Background(), h.scope, "", "", 201); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unbounded list: %v", err)
	}
}

func TestReadOnlyReplayAndPathBoundaries(t *testing.T) {
	h := newHarness(t)
	data := []byte("data")
	request := requestFor("folder/file.md", 0, data)
	first, err := h.s.Save(context.Background(), h.scope, "saved", request, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"folder", "folder/file.md/child"} {
		if _, err := h.s.Save(context.Background(), h.scope, uuid.NewString(), requestFor(path, 0, data), bytes.NewReader(data)); !errors.Is(err, ErrPathCollision) {
			t.Fatalf("path collision %q: %v", path, err)
		}
	}
	h.s.options.ReadOnly = true
	if _, err := h.s.Save(context.Background(), h.scope, "new", request, bytes.NewReader(data)); !errors.Is(err, ErrReadOnly) {
		t.Fatal(err)
	}
	retry, err := h.s.Save(context.Background(), h.scope, "saved", request, bytes.NewReader(data))
	first.Replayed = true
	if err != nil || !reflect.DeepEqual(first, retry) {
		t.Fatalf("read-only replay=%+v %v", retry, err)
	}
	if _, body, err := h.s.Read(context.Background(), h.scope, request.Path, nil); err != nil {
		t.Fatal(err)
	} else {
		body.Close()
	}
}
