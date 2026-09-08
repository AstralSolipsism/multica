// OL-20 shared-resource-zone Phase-0 prototype, v2 (post-review).
//
// Changes over v1 required by the review:
//   P1-1  the idempotency ledger is scoped to (project, actor, op_id) and
//         stores the full request binding (path, base revision, content
//         digest). A hit replays only on an exact match; any mismatch is an
//         explicit ErrOpKeyReused. The ledger is re-checked inside the file
//         lock, so two concurrent saves sharing one operation id resolve to
//         apply+replay, never double-apply. Candidate object keys are random
//         UUIDs, so a racing key reuse cannot overwrite referenced content.
//   P1-2  the actor recorded on every row comes from the grant (authoritative
//         identity); clients no longer supply authors. Authorization is
//         re-checked inside the transaction right before commit, so a grant
//         revoked or a run expired during the upload is rejected even though
//         the upload already succeeded.
//   P2-3  CONFLICT outcomes persist the candidate id and the current revision
//         at conflict time; replays return the identical complete result.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrAnonymous    = errors.New("ol20: anonymous access denied")
	ErrUnauthorized = errors.New("ol20: unknown token")
	ErrWrongProject = errors.New("ol20: token not granted for this project")
	ErrRunExpired   = errors.New("ol20: run grant expired")
	ErrRevoked      = errors.New("ol20: grant revoked")
	ErrNotFound     = errors.New("ol20: file not found")
	// ErrOpKeyReused: the same (project, actor, op_id) was already recorded
	// for a DIFFERENT request — never silently replayed as the old outcome.
	ErrOpKeyReused = errors.New("ol20: operation id already used for a different request")
)

type SaveStatus string

const (
	StatusSaved     SaveStatus = "SAVED"
	StatusConflict  SaveStatus = "CONFLICT"
	StatusDuplicate SaveStatus = "DUPLICATE"
)

type Store struct {
	pool   *pgxpool.Pool
	s3     *s3.Client
	bucket string

	FailDuringUpload error
	FailAfterUpload  error
	FailAfterCommit  error

	// InterludeDuringUpload runs after the object PUT and before the commit
	// re-check — the deterministic hook for "grant revoked / run expired
	// while the upload was in flight" (review P1-2 test).
	InterludeDuringUpload func()
	// InterludeDuringAdopt is the same deterministic hook for the adopt path,
	// firing between the candidate object read and the commit re-check.
	InterludeDuringAdopt func()
}

type SaveRequest struct {
	Token        string
	ProjectID    string
	Path         string
	BaseRevision int64
	Content      []byte
	OpID         string
	// AuthorKind/AuthorID are intentionally absent: the actor is derived
	// from the grant (P1-2). v1 accepted client-supplied authors.
}

// SaveResult is the complete, replayable outcome (P2-3): CONFLICT carries
// the preserved candidate id and the current revision observed at conflict.
type SaveResult struct {
	Status          SaveStatus
	Revision        int64 // SAVED: new current; CONFLICT: current at conflict; DUPLICATE: recorded value
	CandidateID     string
	ConflictCurrent int64
	Replayed        bool
}

func (r SaveResult) String() string {
	if r.Status == StatusConflict || (r.Replayed && r.CandidateID != "") {
		return fmt.Sprintf("status=%s revision=%d candidate=%s replayed=%v", r.Status, r.Revision, r.CandidateID, r.Replayed)
	}
	return fmt.Sprintf("status=%s revision=%d replayed=%v", r.Status, r.Revision, r.Replayed)
}

type Actor struct {
	Kind string
	ID   string
}

type ReadResult struct {
	Path     string
	Revision int64
	Content  []byte
	SHA256   string
}

type Candidate struct {
	ID           string
	BaseRevision int64
	AuthorID     string
	Content      []byte
	SHA256       string
	CreatedAt    time.Time
}

func OpenStore(ctx context.Context, pgURL, s3Endpoint, accessKey, secretKey, bucket, region string) (*Store, error) {
	pool, err := pgxpool.New(ctx, pgURL)
	if err != nil {
		return nil, fmt.Errorf("pg: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("pg ping: %w", err)
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("s3 config: %w", err)
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(s3Endpoint)
		o.UsePathStyle = true
	})
	return &Store{pool: pool, s3: client, bucket: bucket}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) InitSchema(ctx context.Context, ddl string) error {
	_, err := s.pool.Exec(ctx, ddl)
	return err
}

// authorize resolves the authoritative actor or a typed denial. It is the
// only place identity comes from.
func (s *Store) authorize(ctx context.Context, tx pgx.Tx, token, projectID string) (Actor, error) {
	if token == "" {
		return Actor{}, ErrAnonymous
	}
	var (
		proj    string
		kind    string
		actorID string
		expires *time.Time
		revoked *time.Time
	)
	err := tx.QueryRow(ctx,
		`SELECT project_id, kind, actor_id, run_expires_at, revoked_at FROM grants WHERE token=$1`, token,
	).Scan(&proj, &kind, &actorID, &expires, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return Actor{}, ErrUnauthorized
	}
	if err != nil {
		return Actor{}, err
	}
	if proj != projectID {
		return Actor{}, ErrWrongProject
	}
	if revoked != nil {
		return Actor{}, ErrRevoked
	}
	if kind == "run" && expires != nil && expires.Before(time.Now()) {
		return Actor{}, ErrRunExpired
	}
	return Actor{Kind: kind, ID: actorID}, nil
}

func (s *Store) putObject(ctx context.Context, key string, content []byte) (string, int64, error) {
	if err := s.FailDuringUpload; err != nil {
		return "", 0, err
	}
	_, err := s.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(content),
	})
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:]), int64(len(content)), nil
}

func (s *Store) getObject(ctx context.Context, key string) ([]byte, error) {
	out, err := s.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

func randKey() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ledgerRow is the recorded request binding + outcome.
type ledgerRow struct {
	opKind           string
	outcome          string
	revision         int64
	candidateID      *string
	conflictCurrent  *int64
	path             string
	baseRevision     int64
	contentSHA256    string
}

// checkLedger replays a hit only on an exact request match — including the
// operation kind: a key that served the other operation type is a reuse,
// never a replay (architect re-review #1, both directions now).
func checkLedger(row *ledgerRow, wantKind string, path string, baseRevision int64, digest string) (SaveResult, bool, error) {
	if row.opKind != wantKind || row.path != path || row.baseRevision != baseRevision || row.contentSHA256 != digest {
		return SaveResult{}, false, ErrOpKeyReused
	}
	res := SaveResult{Status: SaveStatus(row.outcome), Revision: row.revision, Replayed: true}
	if row.candidateID != nil {
		res.CandidateID = *row.candidateID
	}
	if row.conflictCurrent != nil {
		res.ConflictCurrent = *row.conflictCurrent
	}
	return res, true, nil
}

// rowQuerier abstracts QueryRow over transactions and the pool, so ledger
// lookups can run on a fresh read after a poisoned transaction is rolled
// back (a 23505 inside a tx aborts it; any further statement is 25P02).
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// reclaimLedgerAfterConflict rolls back the aborted transaction and re-reads
// the ledger on a fresh connection: the winner's committed row is visible
// there, giving a replay (identical request) or ErrOpKeyReused (different
// request) instead of leaking the raw database error.
func (s *Store) reclaimLedgerAfterConflict(ctx context.Context, tx pgx.Tx, req SaveRequest, actor Actor, digest string) (SaveResult, bool, error) {
	_ = tx.Rollback(ctx)
	return s.lookupLedger(ctx, s.pool, req, actor, digest)
}

// isUniqueViolation reports a Postgres unique-constraint failure (23505):
// two requests claimed the same ledger key on paths the file lock cannot
// coordinate. The contract is ErrOpKeyReused or a replay — never a raw DB
// error (architect re-review #3).
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *Store) Save(ctx context.Context, req SaveRequest) (SaveResult, error) {
	digest := fmt.Sprintf("%x", sha256.Sum256(req.Content))

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SaveResult{}, err
	}
	defer tx.Rollback(ctx)

	actor, err := s.authorize(ctx, tx, req.Token, req.ProjectID)
	if err != nil {
		return SaveResult{}, err
	}

	// Pre-lock ledger check (cheap replay for the common retry).
	if res, ok, err := s.lookupLedger(ctx, tx, req, actor, digest); ok || err != nil {
		return res, err
	}

	var fileID string
	var current int64
	err = tx.QueryRow(ctx,
		`SELECT id, current_revision FROM files WHERE project_id=$1 AND path=$2 FOR UPDATE`,
		req.ProjectID, req.Path).Scan(&fileID, &current)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		var fresh int64
		err = tx.QueryRow(ctx,
			`INSERT INTO files (project_id, path) VALUES ($1,$2)
			 ON CONFLICT (project_id, path) DO NOTHING
			 RETURNING id, current_revision`, req.ProjectID, req.Path).Scan(&fileID, &fresh)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := tx.QueryRow(ctx,
				`SELECT id, current_revision FROM files WHERE project_id=$1 AND path=$2 FOR UPDATE`,
				req.ProjectID, req.Path).Scan(&fileID, &current); err != nil {
				return SaveResult{}, err
			}
		case err != nil:
			return SaveResult{}, err
		default:
			current = fresh
		}
	case err != nil:
		return SaveResult{}, err
	}

	// In-lock ledger re-check (P1-1): a concurrent save with the same
	// operation id that claimed the ledger while we waited on the file lock
	// replays here instead of applying twice.
	if res, ok, err := s.lookupLedger(ctx, tx, req, actor, digest); ok || err != nil {
		return res, err
	}

	if current == req.BaseRevision {
		newRev := current + 1
		key := fmt.Sprintf("rev/%s/%d/%s", fileID, newRev, req.OpID)
		sum, size, err := s.putObject(ctx, key, req.Content)
		if err != nil {
			return SaveResult{}, fmt.Errorf("upload: %w", err)
		}
		if s.InterludeDuringUpload != nil {
			s.InterludeDuringUpload()
		}
		// Commit-time re-authorization (P1-2): revocation or run expiry that
		// happened during the upload is enforced before anything persists.
		if _, err := s.authorize(ctx, tx, req.Token, req.ProjectID); err != nil {
			return SaveResult{}, err
		}
		if err := s.FailAfterUpload; err != nil {
			return SaveResult{}, err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO revisions (file_id, revision, content_key, size, sha256, author_kind, author_id, op_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			fileID, newRev, key, size, sum, actor.Kind, actor.ID, req.OpID); err != nil {
			return SaveResult{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE files SET current_revision=$2 WHERE id=$1`, fileID, newRev); err != nil {
			return SaveResult{}, err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO op_results (project_id, actor_id, op_id, outcome, revision, path, base_revision, content_sha256, op_kind)
			 VALUES ($1,$2,$3,'SAVED',$4,$5,$6,$7,'save')`,
			req.ProjectID, actor.ID, req.OpID, newRev, req.Path, req.BaseRevision, digest); err != nil {
			if isUniqueViolation(err) {
				// Same ledger key claimed on another path: the tx is aborted
				// (25P02 beyond this point); roll back and re-read fresh.
				if res, hit, lerr := s.reclaimLedgerAfterConflict(ctx, tx, req, actor, digest); hit || lerr != nil {
					return res, lerr
				}
				return SaveResult{}, ErrOpKeyReused
			}
			return SaveResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return SaveResult{}, err
		}
		res := SaveResult{Status: StatusSaved, Revision: newRev}
		if err := s.FailAfterCommit; err != nil {
			return res, err
		}
		return res, nil
	}

	// Diverged: preserve as a candidate under a random, never-reused key.
	candKey := fmt.Sprintf("cand/%s/%s", fileID, randKey())
	sum, size, err := s.putObject(ctx, candKey, req.Content)
	if err != nil {
		return SaveResult{}, fmt.Errorf("upload: %w", err)
	}
	if s.InterludeDuringUpload != nil {
		s.InterludeDuringUpload()
	}
	if _, err := s.authorize(ctx, tx, req.Token, req.ProjectID); err != nil {
		return SaveResult{}, err
	}
	if err := s.FailAfterUpload; err != nil {
		return SaveResult{}, err
	}
	var candID string
	err = tx.QueryRow(ctx,
		`INSERT INTO conflict_candidates (file_id, base_revision, content_key, size, sha256, author_kind, author_id, op_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		fileID, req.BaseRevision, candKey, size, sum, actor.Kind, actor.ID, req.OpID).Scan(&candID)
	if err != nil {
		return SaveResult{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO op_results (project_id, actor_id, op_id, outcome, revision, candidate_id, conflict_current, path, base_revision, content_sha256, op_kind)
		 VALUES ($1,$2,$3,'CONFLICT',$4,$5,$6,$7,$8,$9,'save')`,
		req.ProjectID, actor.ID, req.OpID, current, candID, current, req.Path, req.BaseRevision, digest); err != nil {
		if isUniqueViolation(err) {
			if res, hit, lerr := s.reclaimLedgerAfterConflict(ctx, tx, req, actor, digest); hit || lerr != nil {
				return res, lerr
			}
			return SaveResult{}, ErrOpKeyReused
		}
		return SaveResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SaveResult{}, err
	}
	res := SaveResult{Status: StatusConflict, Revision: current, ConflictCurrent: current, CandidateID: candID}
	if err := s.FailAfterCommit; err != nil {
		return res, err
	}
	return res, nil
}

func (s *Store) lookupLedger(ctx context.Context, q rowQuerier, req SaveRequest, actor Actor, digest string) (SaveResult, bool, error) {
	row := ledgerRow{}
	err := q.QueryRow(ctx,
		`SELECT op_kind, outcome, COALESCE(revision,0), candidate_id, conflict_current, path, base_revision, content_sha256
		 FROM op_results WHERE project_id=$1 AND actor_id=$2 AND op_id=$3`,
		req.ProjectID, actor.ID, req.OpID).
		Scan(&row.opKind, &row.outcome, &row.revision, &row.candidateID, &row.conflictCurrent, &row.path, &row.baseRevision, &row.contentSHA256)
	if errors.Is(err, pgx.ErrNoRows) {
		return SaveResult{}, false, nil
	}
	if err != nil {
		return SaveResult{}, true, err
	}
	res, ok, err := checkLedger(&row, "save", req.Path, req.BaseRevision, digest)
	return res, ok || err != nil, err
}

func (s *Store) authorizeReadOnly(ctx context.Context, token, projectID string) (Actor, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Actor{}, err
	}
	defer tx.Rollback(ctx)
	return s.authorize(ctx, tx, token, projectID)
}

func (s *Store) Read(ctx context.Context, token, projectID, path string) (ReadResult, error) {
	if _, err := s.authorizeReadOnly(ctx, token, projectID); err != nil {
		return ReadResult{}, err
	}
	var rev int64
	var key, sum, p string
	err := s.pool.QueryRow(ctx, `
		SELECT f.path, f.current_revision, r.content_key, r.sha256
		FROM files f
		JOIN revisions r ON r.file_id = f.id AND r.revision = f.current_revision
		WHERE f.project_id=$1 AND f.path=$2`, projectID, path,
	).Scan(&p, &rev, &key, &sum)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReadResult{}, ErrNotFound
	}
	if err != nil {
		return ReadResult{}, err
	}
	content, err := s.getObject(ctx, key)
	if err != nil {
		return ReadResult{}, fmt.Errorf("current revision %d points at missing object %s: %w", rev, key, err)
	}
	return ReadResult{Path: p, Revision: rev, Content: content, SHA256: sum}, nil
}

func (s *Store) List(ctx context.Context, token, projectID, prefix string) ([]string, error) {
	if _, err := s.authorizeReadOnly(ctx, token, projectID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT path FROM files WHERE project_id=$1 AND path LIKE $2||'%' ORDER BY path`, projectID, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) Candidates(ctx context.Context, token, projectID, path string) ([]Candidate, error) {
	if _, err := s.authorizeReadOnly(ctx, token, projectID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.base_revision, c.author_id, c.content_key, c.sha256, c.created_at
		FROM conflict_candidates c
		JOIN files f ON f.id = c.file_id
		WHERE f.project_id=$1 AND f.path=$2
		ORDER BY c.created_at`, projectID, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		var key string
		if err := rows.Scan(&c.ID, &c.BaseRevision, &c.AuthorID, &key, &c.SHA256, &c.CreatedAt); err != nil {
			return nil, err
		}
		content, err := s.getObject(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("candidate %s content missing: %w", c.ID, err)
		}
		c.Content = content
		out = append(out, c)
	}
	return out, rows.Err()
}

// AdoptCandidate re-applies a preserved candidate's content as a NEW save,
// carried by the revision the adoption DECISION was made against
// (expectedRevision, review P1-4). If the head moved since the decision the
// adopt returns a conflict and consumes nothing — the caller re-reviews at
// the new head and re-decides (a fresh operation id).
//
// Its replay binding is (project, actor, op, kind=adopt, path, candidate id,
// expected revision): a key that ever served a different request — another
// candidate, another expected revision, or a Save — is ErrOpKeyReused, never
// a replay of someone else's success. The ledger is re-checked inside the
// file lock (concurrent identical adopts: one applies, the other replays),
// and authorization is re-confirmed right before commit, covering lock wait
// and object read windows.
func (s *Store) AdoptCandidate(ctx context.Context, token, projectID, path, candidateID, opID string, expectedRevision int64) (SaveResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SaveResult{}, err
	}
	defer tx.Rollback(ctx)

	actor, err := s.authorize(ctx, tx, token, projectID)
	if err != nil {
		return SaveResult{}, err
	}

	lookupOn := func(q rowQuerier) (SaveResult, bool, error) {
		var (
			kind          string
			outcome       string
			doneRev       int64
			doneCand      *string
			doneConflict  *int64
			donePath      string
			doneExpected  int64
			doneSHA       string
		)
		err := q.QueryRow(ctx,
			`SELECT op_kind, outcome, COALESCE(revision,0), candidate_id, conflict_current, path, base_revision, content_sha256
			 FROM op_results WHERE project_id=$1 AND actor_id=$2 AND op_id=$3`,
			projectID, actor.ID, opID).
			Scan(&kind, &outcome, &doneRev, &doneCand, &doneConflict, &donePath, &doneExpected, &doneSHA)
		if errors.Is(err, pgx.ErrNoRows) {
			return SaveResult{}, false, nil
		}
		if err != nil {
			return SaveResult{}, true, err
		}
		if kind != "adopt" || donePath != path || doneCand == nil || *doneCand != candidateID || doneExpected != expectedRevision {
			return SaveResult{}, true, ErrOpKeyReused
		}
		res := SaveResult{Status: SaveStatus(outcome), Revision: doneRev, Replayed: true, CandidateID: candidateID}
		if doneConflict != nil {
			res.ConflictCurrent = *doneConflict
		}
		return res, true, nil
	}

	lookup := func() (SaveResult, bool, error) { return lookupOn(tx) }
	reclaim := func() (SaveResult, bool, error) {
		_ = tx.Rollback(ctx)
		fresh, ferr := s.pool.Begin(ctx)
		if ferr != nil {
			return SaveResult{}, true, ferr
		}
		defer fresh.Rollback(ctx)
		return lookupOn(fresh)
	}

	// Pre-lock replay + cross-type key check.
	if res, hit, err := lookup(); hit {
		return res, err
	}

	var fileID string
	var current int64
	if err := tx.QueryRow(ctx,
		`SELECT f.id, f.current_revision FROM files f WHERE f.project_id=$1 AND f.path=$2 FOR UPDATE`,
		projectID, path).Scan(&fileID, &current); err != nil {
		return SaveResult{}, err
	}

	// In-lock replay re-check (concurrent identical adopt).
	if res, hit, err := lookup(); hit {
		return res, err
	}

	var contentKey string
	err = tx.QueryRow(ctx,
		`SELECT content_key FROM conflict_candidates WHERE id=$1 AND file_id=$2`, candidateID, fileID).Scan(&contentKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return SaveResult{}, ErrNotFound
	}
	if err != nil {
		return SaveResult{}, err
	}
	content, err := s.getObject(ctx, contentKey)
	if err != nil {
		return SaveResult{}, err
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(content))

	// Commit-window authorization re-check (same contract as Save).
	if s.InterludeDuringAdopt != nil {
		s.InterludeDuringAdopt()
	}
	if _, err := s.authorize(ctx, tx, token, projectID); err != nil {
		return SaveResult{}, err
	}

	// The decision is stale: the head moved after the user chose to adopt.
	// Keep the head AND the candidate, but RECORD the conflict outcome — a
	// retry of the same request replays this exact result (architect
	// re-review #2), it does not drift with a head that moved again.
	if current != expectedRevision {
		if _, err := tx.Exec(ctx,
			`INSERT INTO op_results (project_id, actor_id, op_id, outcome, revision, candidate_id, conflict_current, path, base_revision, content_sha256, op_kind)
			 VALUES ($1,$2,$3,'CONFLICT',$4,$5,$6,$7,$8,$9,'adopt')`,
			projectID, actor.ID, opID, current, candidateID, current, path, expectedRevision, sum); err != nil {
			if isUniqueViolation(err) {
				if res, hit, lerr := reclaim(); hit || lerr != nil {
					return res, lerr
				}
				return SaveResult{}, ErrOpKeyReused
			}
			return SaveResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return SaveResult{}, err
		}
		return SaveResult{
			Status:          StatusConflict,
			Revision:        current,
			ConflictCurrent: current,
			CandidateID:     candidateID,
		}, nil
	}

	newRev := current + 1
	// Reference the candidate's existing object key: no re-upload, and the
	// GC reference simply moves from the candidate table to the revision
	// table (the candidate row is deleted below in the same transaction).
	if _, err := tx.Exec(ctx,
		`INSERT INTO revisions (file_id, revision, content_key, size, sha256, author_kind, author_id, op_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		fileID, newRev, contentKey, int64(len(content)), sum, actor.Kind, actor.ID, opID); err != nil {
		return SaveResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET current_revision=$2 WHERE id=$1`, fileID, newRev); err != nil {
		return SaveResult{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM conflict_candidates WHERE id=$1`, candidateID); err != nil {
		return SaveResult{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO op_results (project_id, actor_id, op_id, outcome, revision, candidate_id, base_revision, path, content_sha256, op_kind)
		 VALUES ($1,$2,$3,'SAVED',$4,$5,$6,$7,$8,'adopt')`,
		projectID, actor.ID, opID, newRev, candidateID, expectedRevision, path, sum); err != nil {
		if isUniqueViolation(err) {
			if res, hit, lerr := reclaim(); hit || lerr != nil {
				return res, lerr
			}
			return SaveResult{}, ErrOpKeyReused
		}
		return SaveResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SaveResult{}, err
	}
	return SaveResult{Status: StatusSaved, Revision: newRev}, nil
}

func (s *Store) Grant(ctx context.Context, token, projectID, kind, actorID string, expires *time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO grants (token, project_id, kind, actor_id, run_expires_at) VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (token) DO NOTHING`, token, projectID, kind, actorID, expires)
	return err
}

func (s *Store) Revoke(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `UPDATE grants SET revoked_at=now() WHERE token=$1`, token)
	return err
}

func (s *Store) ExpireGrant(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `UPDATE grants SET run_expires_at=now() WHERE token=$1`, token)
	return err
}

func (s *Store) Orphans(ctx context.Context) ([]string, error) {
	referenced := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT content_key FROM revisions UNION ALL SELECT content_key FROM conflict_candidates`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return nil, err
		}
		referenced[k] = true
	}
	rows.Close()

	var orphans []string
	p := s3.NewListObjectsV2Paginator(s.s3, &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket)})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, obj := range page.Contents {
			if !referenced[aws.ToString(obj.Key)] {
				orphans = append(orphans, aws.ToString(obj.Key))
			}
		}
	}
	return orphans, nil
}

func (s *Store) RevisionContent(ctx context.Context, token, projectID, path string, revision int64) ([]byte, error) {
	if _, err := s.authorizeReadOnly(ctx, token, projectID); err != nil {
		return nil, err
	}
	var key string
	err := s.pool.QueryRow(ctx, `
		SELECT r.content_key FROM revisions r
		JOIN files f ON f.id = r.file_id
		WHERE f.project_id=$1 AND f.path=$2 AND r.revision=$3`, projectID, path, revision).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.getObject(ctx, key)
}
