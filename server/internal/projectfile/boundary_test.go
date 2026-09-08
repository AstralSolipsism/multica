package projectfile

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestPathAndContentBoundaries(t *testing.T) {
	for _, path := range []string{"", "/a", "a/", "a//b", "a/../b", "./a", "a\\b", "a\x00", "a\n", string([]byte{255}), strings.Repeat("x", 256)} {
		if ValidatePath(path) == nil {
			t.Errorf("accepted ambiguous path %q", path)
		}
	}
	for _, path := range []string{"中文/资料.md", "emoji/🐈.png", "a%b_c.txt"} {
		if err := ValidatePath(path); err != nil {
			t.Errorf("valid path %q: %v", path, err)
		}
	}
	for _, data := range [][]byte{nil, []byte("hello"), {0, 255, 10}} {
		req := requestFor("file", 0, data)
		if err := verifyContent(bytes.NewReader(data), req, nil); err != nil {
			t.Fatal(err)
		}
		if err := verifyContent(bytes.NewReader(append(append([]byte{}, data...), 0)), req, nil); !errors.Is(err, ErrContentMismatch) {
			t.Fatalf("extra data: %v", err)
		}
		if len(data) > 0 {
			if err := verifyContent(bytes.NewReader(data[:len(data)-1]), req, nil); !errors.Is(err, ErrContentMismatch) {
				t.Fatalf("truncation: %v", err)
			}
			if err := verifyContent(bytes.NewReader(data), req, func(io.Reader) error { return nil }); !errors.Is(err, ErrContentMismatch) {
				t.Fatalf("storage did not consume input: %v", err)
			}
		}
	}
}

type expiryBeginner struct {
	*pgxpool.Pool
	taskID  string
	checked *atomic.Bool
}
type expiryTx struct {
	pgx.Tx
	taskID  string
	checked *atomic.Bool
}

func (b expiryBeginner) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := b.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return expiryTx{tx, b.taskID, b.checked}, nil
}
func (tx expiryTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "-- name: CompleteProjectFileOperation") {
		// Model expiry precisely after the candidate/head mutations, without
		// a wall-clock deadline that could expire during slow CI fixture setup.
		if _, err := tx.Tx.Exec(ctx, "UPDATE task_token SET expires_at=clock_timestamp() WHERE task_id=$1", tx.taskID); err != nil {
			return pgconn.CommandTag{}, err
		}
		tx.checked.Store(true)
	}
	return tx.Tx.Exec(ctx, sql, args...)
}

// Ported review scenario: a live run expires after adoption starts but before
// its result commits. All candidate/head/version/ledger mutations must roll back.
func TestReviewAdoptExpiredBeforeCommit(t *testing.T) {
	h, candidate := reviewCandidate(t)
	scope := h.run(t, false)
	checked := &atomic.Bool{}
	h.s.beginner = expiryBeginner{h.pool, scope.Identity.TaskID, checked}
	if _, err := h.s.Adopt(context.Background(), scope, "expired", adoptRequest(candidate, 2)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expired adoption: %v", err)
	}
	if !checked.Load() {
		t.Fatal("test did not reach the final commit window")
	}
	if n := h.fx.Count(t, "SELECT count(*) FROM project_file_operation WHERE project_id=$1 AND operation_key='expired'", scope.ProjectID); n != 0 {
		t.Fatalf("rolled-back adoption left ledger: %d", n)
	}
	if n := h.fx.Count(t, "SELECT count(*) FROM project_file_candidate WHERE id=$1 AND resolved_at IS NULL", candidate.CandidateID); n != 1 {
		t.Fatal("candidate consumed by expired run")
	}
	if n := h.fx.Count(t, "SELECT count(*) FROM project_file WHERE id=$1 AND revision=2", candidate.FileID); n != 1 {
		t.Fatal("expired run changed head")
	}
}

func TestProjectFileVerificationWithRetainedStates(t *testing.T) {
	h, _ := reviewCandidate(t)
	h.save(t, "empty.bin", 0, "")
	h.objects.afterPut = func(context.Context, string) error { return errors.New("injected pending upload") }
	data := []byte("pending")
	if _, err := h.s.Save(context.Background(), h.scope, "pending", requestFor("pending.bin", 0, data), bytes.NewReader(data)); !errors.Is(err, ErrStorage) {
		t.Fatalf("expected retained pending upload: %v", err)
	}
	script, err := os.ReadFile("../../scripts/project-files-verify.sql")
	if err != nil {
		t.Fatal(err)
	}
	h.fx.Exec(t, string(script))
}

func TestProjectAndMemberOperationIsolation(t *testing.T) {
	h := newHarness(t)
	data := []byte("same")
	request := requestFor("facts.md", 0, data)
	first, err := h.s.Save(context.Background(), h.scope, "same", request, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	other := h.scope
	other.ProjectID = util.MustParseUUID(h.fx.Project(t, "Second project"))
	for _, table := range []string{"project_file", "project_file_version", "project_file_candidate", "project_file_operation", "project_file_upload"} {
		h.fx.Cleanup(t, "DELETE FROM "+table+" WHERE project_id=$1", other.ProjectID)
	}
	result, err := h.s.Save(context.Background(), other, "same", request, bytes.NewReader(data))
	if err != nil || result.Replayed || result.FileID == first.FileID {
		t.Fatalf("project isolation: %+v %v", result, err)
	}
	user := h.fx.User(t, "Second member", uuid.NewString()+"@example.invalid")
	h.fx.Member(t, h.fx.WorkspaceID, user, "member")
	member := h.scope
	member.Identity.UserID = user
	result, err = h.s.Save(context.Background(), member, "same", request, bytes.NewReader(data))
	if err != nil || result.Replayed || result.Status != StatusConflict {
		t.Fatalf("member isolation: %+v %v", result, err)
	}
	wrongWorkspace := h.scope
	wrongWorkspace.WorkspaceID = util.MustParseUUID(uuid.NewString())
	if err := h.s.CheckAccess(context.Background(), wrongWorkspace); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross workspace: %v", err)
	}
}

func TestConcurrentFileWriters100Rounds(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for round := range 100 {
		path := fmt.Sprintf("rounds/%03d.bin", round)
		h.save(t, path, 0, "base")
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
			result Result
			err    error
			data   []byte
		}
		results := make(chan outcome, 2)
		for writer := range 2 {
			data := []byte(fmt.Sprintf("round %d writer %d", round, writer))
			if round%2 == 0 {
				data = append(data, 0, 255)
			}
			go func(data []byte) {
				r, e := h.s.Save(ctx, h.scope, uuid.NewString(), requestFor(path, 1, data), bytes.NewReader(data))
				results <- outcome{r, e, data}
			}(data)
		}
		for range 2 {
			select {
			case <-arrived:
			case <-ctx.Done():
				close(release)
				t.Fatal("upload barrier timeout")
			}
		}
		close(release)
		a, b := <-results, <-results
		h.objects.afterPut = nil
		if a.err != nil || b.err != nil {
			t.Fatalf("round %d: %v %v", round, a.err, b.err)
		}
		if a.result.Status == StatusConflict {
			a, b = b, a
		}
		if a.result.Status != StatusSaved || b.result.Status != StatusConflict || a.result.Revision != 2 || b.result.Revision != 2 {
			t.Fatalf("round %d: %+v %+v", round, a.result, b.result)
		}
		_, current, err := h.s.Read(ctx, h.scope, path, nil)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(current)
		current.Close()
		if err != nil || !bytes.Equal(got, a.data) {
			t.Fatalf("round %d lost current: %v", round, err)
		}
		_, candidate, err := h.s.ReadCandidate(ctx, h.scope, util.MustParseUUID(b.result.CandidateID))
		if err != nil {
			t.Fatal(err)
		}
		got, err = io.ReadAll(candidate)
		candidate.Close()
		if err != nil || !bytes.Equal(got, b.data) {
			t.Fatalf("round %d lost candidate: %v", round, err)
		}
		rev := int64(1)
		_, old, err := h.s.Read(ctx, h.scope, path, &rev)
		if err != nil {
			t.Fatal(err)
		}
		got, err = io.ReadAll(old)
		old.Close()
		if err != nil || string(got) != "base" {
			t.Fatalf("round %d lost history: %v", round, err)
		}
	}
}
