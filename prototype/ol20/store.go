// OL-20 shared-resource-zone Phase-0 prototype: a versioned file store over
// real PostgreSQL (directory/version/conflict state) and real MinIO (content).
//
// The contract under test is the save path from 方案 v1:
//   - every save carries the base revision it was made against;
//   - matching base  -> new current revision (SAVED);
//   - stale base     -> content preserved as a conflict candidate (CONFLICT);
//   - retries with the same operation id replay the recorded outcome and
//     never re-apply the write (idempotency ledger op_results);
//   - a current revision never points at a missing object.
//
// Failure hooks (FailAfterUpload / FailAfterCommit) implement the three
// interruption points of acceptance item 2; they are test-only injection
// points, unset in normal operation.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel authorization errors — item 3 requires distinguishing every
// denial reason across all entry points.
var (
	ErrAnonymous    = errors.New("ol20: anonymous access denied")
	ErrUnauthorized = errors.New("ol20: unknown token")
	ErrWrongProject = errors.New("ol20: token not granted for this project")
	ErrRunExpired   = errors.New("ol20: run grant expired")
	ErrRevoked      = errors.New("ol20: grant revoked")
	ErrNotFound     = errors.New("ol20: file not found")
)

type SaveStatus string

const (
	StatusSaved     SaveStatus = "SAVED"
	StatusConflict  SaveStatus = "CONFLICT"
	StatusDuplicate SaveStatus = "DUPLICATE" // replay of a recorded outcome
)

type Store struct {
	pool   *pgxpool.Pool
	s3     *s3.Client
	bucket string

	// Failure injection (item 2). When set, the hook fires at the named
	// point and the save returns this error to the caller.
	FailDuringUpload error // aborts the object PUT itself
	FailAfterUpload  error // object stored, transaction rolled back
	FailAfterCommit  error // transaction committed, response discarded
}

type SaveRequest struct {
	Token        string
	ProjectID    string
	Path         string
	BaseRevision int64
	Content      []byte
	OpID         string
	AuthorKind   string // "user" | "run"
	AuthorID     string
}

type SaveResult struct {
	Status   SaveStatus
	Revision int64
	Replayed bool
}

type ReadResult struct {
	Path     string
	Revision int64
	Content  []byte
	SHA256   string
}

type Candidate struct {
	ID            string
	BaseRevision  int64
	AuthorID      string
	Content       []byte
	SHA256        string
	CreatedAt     time.Time
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

// InitSchema applies schema.sql. Idempotent.
func (s *Store) InitSchema(ctx context.Context, ddl string) error {
	_, err := s.pool.Exec(ctx, ddl)
	return err
}

// authorize is the single permission gate. Every entry point (list, read,
// save, candidates) calls it with the same token+project pair.
func (s *Store) authorize(ctx context.Context, token, projectID string) error {
	if token == "" {
		return ErrAnonymous
	}
	var (
		proj     string
		kind     string
		expires  *time.Time
		revoked  *time.Time
	)
	err := s.pool.QueryRow(ctx,
		`SELECT project_id, kind, run_expires_at, revoked_at FROM grants WHERE token=$1`, token,
	).Scan(&proj, &kind, &expires, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if proj != projectID {
		return ErrWrongProject
	}
	if revoked != nil {
		return ErrRevoked
	}
	if kind == "run" && expires != nil && expires.Before(time.Now()) {
		return ErrRunExpired
	}
	return nil
}

func (s *Store) putObject(ctx context.Context, key string, content []byte) (string, int64, error) {
	if err := s.FailDuringUpload; err != nil {
		return "", 0, err
	}
	_, err := s.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   bytesReader(content),
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

// Save implements the whole contract. Serialization point: SELECT ... FOR
// UPDATE on the file row, so two savers of the same file are strictly ordered
// and the later stale-base writer deterministically becomes a candidate.
func (s *Store) Save(ctx context.Context, req SaveRequest) (SaveResult, error) {
	if err := s.authorize(ctx, req.Token, req.ProjectID); err != nil {
		return SaveResult{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SaveResult{}, err
	}
	defer tx.Rollback(ctx) // no-op after commit

	// Idempotency ledger first: a retry must replay, never re-apply.
	var outcome string
	var rev int64
	err = tx.QueryRow(ctx, `SELECT outcome, COALESCE(revision,0) FROM op_results WHERE op_id=$1`, req.OpID).Scan(&outcome, &rev)
	if err == nil {
		return SaveResult{Status: SaveStatus(outcome), Revision: rev, Replayed: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SaveResult{}, err
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
			// Concurrent creator won the insert; take the lock and read.
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

	if current == req.BaseRevision {
		// Fast path: base matches -> new current revision.
		newRev := current + 1
		key := fmt.Sprintf("rev/%s/%d/%s", fileID, newRev, req.OpID)
		sum, size, err := s.putObject(ctx, key, req.Content)
		if err != nil {
			return SaveResult{}, fmt.Errorf("upload: %w", err)
		}
		if err := s.FailAfterUpload; err != nil {
			return SaveResult{}, err // tx rolls back; object becomes GC-able orphan
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO revisions (file_id, revision, content_key, size, sha256, author_kind, author_id, op_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			fileID, newRev, key, size, sum, req.AuthorKind, req.AuthorID, req.OpID); err != nil {
			return SaveResult{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE files SET current_revision=$2 WHERE id=$1`, fileID, newRev); err != nil {
			return SaveResult{}, err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO op_results (op_id, outcome, revision) VALUES ($1,'SAVED',$2)`, req.OpID, newRev); err != nil {
			return SaveResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return SaveResult{}, err
		}
		res := SaveResult{Status: StatusSaved, Revision: newRev}
		if err := s.FailAfterCommit; err != nil {
			return res, err // committed; caller saw an error (response lost)
		}
		return res, nil
	}

	// Diverged: preserve the writer's content verbatim as a candidate.
	key := fmt.Sprintf("cand/%s/%s", fileID, req.OpID)
	sum, size, err := s.putObject(ctx, key, req.Content)
	if err != nil {
		return SaveResult{}, fmt.Errorf("upload: %w", err)
	}
	if err := s.FailAfterUpload; err != nil {
		return SaveResult{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO conflict_candidates (file_id, base_revision, content_key, size, sha256, author_kind, author_id, op_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		fileID, req.BaseRevision, key, size, sum, req.AuthorKind, req.AuthorID, req.OpID); err != nil {
		return SaveResult{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO op_results (op_id, outcome, note) VALUES ($1,'CONFLICT','candidate preserved')`, req.OpID); err != nil {
		return SaveResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SaveResult{}, err
	}
	res := SaveResult{Status: StatusConflict, Revision: current}
	if err := s.FailAfterCommit; err != nil {
		return res, err
	}
	return res, nil
}

// Read returns the current revision's content. Authorization shares the same
// gate as save: content, history and candidates are equally protected.
func (s *Store) Read(ctx context.Context, token, projectID, path string) (ReadResult, error) {
	if err := s.authorize(ctx, token, projectID); err != nil {
		return ReadResult{}, err
	}
	var (
		rev  int64
		key  string
		sum  string
		p    string
	)
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

// List returns paths + revisions only — deliberately no content, so nothing
// approaches "full injection": exploring is cheap and content is pull-only.
func (s *Store) List(ctx context.Context, token, projectID, prefix string) ([]string, error) {
	if err := s.authorize(ctx, token, projectID); err != nil {
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

// Candidates lists divergence copies for one file, content included — the
// loser's work must always be retrievable.
func (s *Store) Candidates(ctx context.Context, token, projectID, path string) ([]Candidate, error) {
	if err := s.authorize(ctx, token, projectID); err != nil {
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

// Grant creates a test identity.
func (s *Store) Grant(ctx context.Context, token, projectID, kind string, expires *time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO grants (token, project_id, kind, run_expires_at) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (token) DO NOTHING`, token, projectID, kind, expires)
	return err
}

func (s *Store) Revoke(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `UPDATE grants SET revoked_at=now() WHERE token=$1`, token)
	return err
}

// Orphans lists stored objects no row references — the GC surface. Phase-0
// allows orphans from injected failures; it must never allow the reverse
// (a referenced key missing from the store).
func (s *Store) Orphans(ctx context.Context) ([]string, error) {
	prefixes := map[string]bool{}
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
		prefixes[k] = true
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
			if !prefixes[aws.ToString(obj.Key)] {
				orphans = append(orphans, aws.ToString(obj.Key))
			}
		}
	}
	return orphans, nil
}

// trimGC is a helper for sweep assertions.
func (s *Store) ReferencedKeys(ctx context.Context) (map[string]bool, error) {
	out := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT content_key FROM revisions UNION ALL SELECT content_key FROM conflict_candidates`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out[k] = true
	}
	return out, rows.Err()
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func validPath(p string) bool {
	return strings.HasPrefix(p, "/") && !strings.Contains(p, "..")
}
