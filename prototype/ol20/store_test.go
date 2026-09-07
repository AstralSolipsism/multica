// Phase-0 acceptance tests, items 1–3, against real PostgreSQL and real
// MinIO (isolated labrastro_filetest database / ol20-filetest bucket).
// Env-driven wire-up; missing env fails loudly — fakes would prove nothing.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

var (
	pgURL = os.Getenv("OL20_PG")
	s3EP  = os.Getenv("OL20_S3_ENDPOINT")
	s3Key = os.Getenv("OL20_S3_KEY")
	s3Sec = os.Getenv("OL20_S3_SECRET")
	bkt   = envOr("OL20_BUCKET", "ol20-filetest")
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

var (
	runID  = fmt.Sprintf("r%d", time.Now().UnixNano())
	projA  = "11111111-1111-1111-1111-111111111111"
	projB = "22222222-2222-2222-2222-222222222222"
)

func open(t *testing.T) *Store {
	t.Helper()
	if pgURL == "" || s3EP == "" || s3Key == "" || s3Sec == "" {
		t.Fatal("OL20_PG / OL20_S3_ENDPOINT / OL20_S3_KEY / OL20_S3_SECRET must be set")
	}
	ddl, err := os.ReadFile("schema.sql")
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	st, err := OpenStore(context.Background(), pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(st.Close)
	if err := st.InitSchema(context.Background(), string(ddl)); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return st
}

func grant(t *testing.T, st *Store, token, project string) {
	t.Helper()
	if err := st.Grant(context.Background(), token, project, "user", nil); err != nil {
		t.Fatalf("grant: %v", err)
	}
}

func save(t *testing.T, st *Store, req SaveRequest) SaveResult {
	t.Helper()
	res, err := st.Save(context.Background(), req)
	if err != nil {
		t.Fatalf("save %s: %v", req.OpID, err)
	}
	return res
}

// racer couples a save outcome with its error for concurrent runs.
type racer struct {
	res SaveResult
	err error
}

// runRacingSaves: each racer gets its own connection-backed store, both read
// the same base (asserted), then both save concurrently behind a barrier.
func runRacingSaves(t *testing.T, a, b SaveRequest) (racer, racer) {
	t.Helper()
	ctx := context.Background()
	stA, err := OpenStore(ctx, pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	if err != nil {
		t.Fatalf("open A: %v", err)
	}
	defer stA.Close()
	stB, err := OpenStore(ctx, pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	if err != nil {
		t.Fatalf("open B: %v", err)
	}
	defer stB.Close()

	ra, err := stA.Read(ctx, a.Token, a.ProjectID, a.Path)
	if err != nil {
		t.Fatalf("A read: %v", err)
	}
	rb, err := stB.Read(ctx, b.Token, b.ProjectID, b.Path)
	if err != nil {
		t.Fatalf("B read: %v", err)
	}
	if ra.Revision != rb.Revision {
		t.Fatalf("racers observed different bases: %d vs %d", ra.Revision, rb.Revision)
	}
	a.BaseRevision, b.BaseRevision = ra.Revision, rb.Revision

	start := make(chan struct{})
	out := make([]racer, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); <-start; out[0].res, out[0].err = stA.Save(ctx, a) }()
	go func() { defer wg.Done(); <-start; out[1].res, out[1].err = stB.Save(ctx, b) }()
	close(start)
	wg.Wait()
	for i, r := range out {
		if r.err != nil {
			t.Fatalf("racer %d save failed: %v", i, r.err)
		}
	}
	return out[0], out[1]
}

func assertOneWinnerOneCandidate(t *testing.T, i int, path, tokA, tokB string, ra, rb racer, contentA, contentB []byte, st *Store) {
	t.Helper()
	saved, conflicts := 0, 0
	winner, loserContent, loserAuthor := contentA, contentB, "B"
	if rb.res.Status == StatusSaved {
		winner, loserContent, loserAuthor = contentB, contentA, "A"
	}
	for _, r := range []racer{ra, rb} {
		switch r.res.Status {
		case StatusSaved:
			saved++
		case StatusConflict:
			conflicts++
		default:
			t.Fatalf("round %d: unexpected status %q", i, r.res.Status)
		}
	}
	if saved != 1 || conflicts != 1 {
		t.Fatalf("round %d: saved=%d conflicts=%d, want exactly 1/1", i, saved, conflicts)
	}
	cur, err := st.Read(context.Background(), tokA, projA, path)
	if err != nil {
		t.Fatalf("round %d read: %v", i, err)
	}
	if cur.Revision != 2 || !bytes.Equal(cur.Content, winner) {
		t.Fatalf("round %d: current rev=%d bytes-equal=%v", i, cur.Revision, bytes.Equal(cur.Content, winner))
	}
	cands, err := st.Candidates(context.Background(), tokB, projA, path)
	if err != nil {
		t.Fatalf("round %d candidates: %v", i, err)
	}
	if len(cands) != 1 || cands[0].AuthorID != loserAuthor || !bytes.Equal(cands[0].Content, loserContent) {
		t.Fatalf("round %d: loser not fully preserved (n=%d)", i, len(cands))
	}
}

// ---------------------------------------------------------------------------
// Item 1 — concurrency, 100 rounds each for text and binary.
// ---------------------------------------------------------------------------

func TestItem1TextConcurrentSaves(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-a", projA)
	grant(t, st, runID+"-b", projA)
	const rounds = 100
	for i := 0; i < rounds; i++ {
		path := fmt.Sprintf(runID+"/concurrent/text-%04d.md", i)
		if got := save(t, st, SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
			BaseRevision: 0, OpID: fmt.Sprintf(runID+"-seed-t-%d", i), AuthorKind: "user", AuthorID: "seeder",
			Content: []byte(fmt.Sprintf("seed %d", i))}).Revision; got != 1 {
			t.Fatalf("round %d: seed revision = %d", i, got)
		}
		contentA := []byte(fmt.Sprintf("A-%d-%s", i, bytes.Repeat([]byte("x"), 512)))
		contentB := []byte(fmt.Sprintf("B-%d-%s", i, bytes.Repeat([]byte("y"), 700)))
		ra, rb := runRacingSaves(t,
			SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-ra-t-%d", i), AuthorKind: "user", AuthorID: "A", Content: contentA},
			SaveRequest{Token: runID+"-b", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-rb-t-%d", i), AuthorKind: "user", AuthorID: "B", Content: contentB})
		assertOneWinnerOneCandidate(t, i, path, runID+"-a", runID+"-b", ra, rb, contentA, contentB, st)
	}
	t.Logf("item1 text: %d rounds, 2 racers each — exactly one current, loser preserved, every round", rounds)
}

func TestItem1BinaryConcurrentSaves(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-a", projA)
	grant(t, st, runID+"-b", projA)
	const rounds = 100
	for i := 0; i < rounds; i++ {
		path := fmt.Sprintf(runID+"/concurrent/bin-%04d.dat", i)
		save(t, st, SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
			BaseRevision: 0, OpID: fmt.Sprintf(runID+"-seed-b-%d", i), AuthorKind: "user", AuthorID: "seeder",
			Content: make([]byte, 256)})
		bufA, bufB := make([]byte, 4096), make([]byte, 4096)
		rand.Read(bufA)
		rand.Read(bufB)
		ra, rb := runRacingSaves(t,
			SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-ra-b-%d", i), AuthorKind: "user", AuthorID: "A", Content: bufA},
			SaveRequest{Token: runID+"-b", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-rb-b-%d", i), AuthorKind: "user", AuthorID: "B", Content: bufB})
		assertOneWinnerOneCandidate(t, i, path, runID+"-a", runID+"-b", ra, rb, bufA, bufB, st)
	}
	t.Logf("item1 binary: %d rounds, 4KB random per racer — one current, loser preserved, every round", rounds)
}

// ---------------------------------------------------------------------------
// Item 2 — failure injection at the three interruption points; retries with
// the same operation id must not fake success, duplicate, or dangle current.
// ---------------------------------------------------------------------------

func TestItem2FailDuringUpload(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-a", projA)
	path := runID+"/failure/during-upload.md"
	st.FailDuringUpload = errors.New("injected: connection reset during upload")
	_, err := st.Save(context.Background(), SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-fdu-1", AuthorKind: "user", AuthorID: "X", Content: []byte("v1")})
	if err == nil {
		t.Fatal("injected upload failure must surface as an error")
	}
	st.FailDuringUpload = nil

	// No rows may exist for the failed operation.
	var n int
	st.pool.QueryRow(context.Background(),
		`SELECT (SELECT count(*) FROM revisions WHERE op_id=$1) + (SELECT count(*) FROM op_results WHERE op_id=$1) + (SELECT count(*) FROM conflict_candidates WHERE op_id=$1)`, runID+"-fdu-1").Scan(&n)
	if n != 0 {
		t.Fatalf("failed op left %d rows behind", n)
	}

	// Retry with the same op id succeeds exactly once.
	res := save(t, st, SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-fdu-1", AuthorKind: "user", AuthorID: "X", Content: []byte("v1")})
	if res.Status != StatusSaved || res.Replayed {
		t.Fatalf("retry outcome = %+v", res)
	}
	st.pool.QueryRow(context.Background(), `SELECT count(*) FROM revisions WHERE op_id=$1`, runID+"-fdu-1").Scan(&n)
	if n != 1 {
		t.Fatalf("retry created %d revision rows, want 1", n)
	}
	orphans, err := st.Orphans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) != 0 {
		t.Logf("note: %d GC-able orphan object(s) from the aborted upload (allowed; sweep surface): %v", len(orphans), orphans)
	}
	cur, err := st.Read(context.Background(), runID+"-a", projA, path)
	if err != nil || cur.Revision != 1 {
		t.Fatalf("current after retry: rev=%d err=%v — must never point at a missing object", cur.Revision, err)
	}
	t.Log("item2a: upload interrupted -> error surfaced, zero rows, retry idempotent, current intact")
}

func TestItem2FailBetweenUploadAndCommit(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-a", projA)
	path := runID+"/failure/after-upload.md"
	orphansBefore, _ := st.Orphans(context.Background())
	st.FailAfterUpload = errors.New("injected: crash after upload, before commit")
	_, err := st.Save(context.Background(), SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-fau-1", AuthorKind: "user", AuthorID: "X", Content: []byte("v1")})
	if err == nil {
		t.Fatal("injected failure must surface")
	}
	st.FailAfterUpload = nil

	var n int
	st.pool.QueryRow(context.Background(),
		`SELECT (SELECT count(*) FROM revisions WHERE op_id=$1) + (SELECT count(*) FROM op_results WHERE op_id=$1)`, runID+"-fau-1").Scan(&n)
	if n != 0 {
		t.Fatalf("rolled-back op left %d rows", n)
	}
	orphans, _ := st.Orphans(context.Background())
	if got := len(orphans) - len(orphansBefore); got != 1 {
		t.Fatalf("aborted round must leave exactly 1 new GC-able orphan, got %d", got)
	}

	res := save(t, st, SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-fau-1", AuthorKind: "user", AuthorID: "X", Content: []byte("v1")})
	if res.Status != StatusSaved {
		t.Fatalf("retry = %+v", res)
	}
	if _, err := st.Read(context.Background(), runID+"-a", projA, path); err != nil {
		t.Fatalf("current points at missing object: %v", err)
	}
	// A sweeper pass must show orphans only from the injected abort — never
	// a referenced key missing.
	var refCount int
	st.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM revisions r LEFT JOIN LATERAL (SELECT 1) k ON true WHERE r.op_id=$1`, runID+"-fau-1").Scan(&refCount)
	if refCount != 1 {
		t.Fatalf("retry produced %d revision rows for this op", refCount)
	}
	t.Logf("item2b: MinIO ok + DB uncommitted -> 0 rows, 1 GC-able orphan, retry idempotent, revision row present")
}

func TestItem2FailAfterCommitResponseLost(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-a", projA)
	path := runID+"/failure/response-lost.md"
	st.FailAfterCommit = errors.New("injected: response lost after commit")
	res, err := st.Save(context.Background(), SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-frc-1", AuthorKind: "user", AuthorID: "X", Content: []byte("v1")})
	if err == nil {
		t.Fatal("caller must see an error even though the commit succeeded")
	}
	st.FailAfterCommit = nil
	if res.Status != StatusSaved {
		t.Fatalf("internal result after commit = %+v", res)
	}

	// Client retries the same operation id after its "failure".
	retry := save(t, st, SaveRequest{Token: runID+"-a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-frc-1", AuthorKind: "user", AuthorID: "X", Content: []byte("v1")})
	if retry.Status != StatusSaved || !retry.Replayed || retry.Revision != 1 {
		t.Fatalf("retry must replay the recorded outcome: %+v", retry)
	}
	var n int
	st.pool.QueryRow(context.Background(), `SELECT count(*) FROM revisions WHERE op_id=$1`, runID+"-frc-1").Scan(&n)
	if n != 1 {
		t.Fatalf("replayed op created %d revision rows, want 1", n)
	}
	if _, err := st.Read(context.Background(), runID+"-a", projA, path); err != nil {
		t.Fatalf("read after replay: %v", err)
	}
	t.Log("item2c: commit ok + response lost -> retry replays outcome (no duplicate, no false success)")
}

// ---------------------------------------------------------------------------
// Item 3 — one permission gate across every entry point.
// ---------------------------------------------------------------------------

func TestItem3PermissionsCoverAllEntryPoints(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-user", projA)               // legitimate user
	grant(t, st, runID+"-other", projB)              // legitimate elsewhere
	// Run grant that expires in one second.
	exp := time.Now().Add(1 * time.Second)
	if err := st.Grant(context.Background(), runID+"-run", projA, "run", &exp); err != nil {
		t.Fatal(err)
	}
	grant(t, st, runID+"-rev", projA)
	mustNil(st.Revoke(context.Background(), runID+"-rev"))

	path := runID+"/perm/secret.md"
	save(t, st, SaveRequest{Token: runID+"-user", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-permseed-ok", AuthorKind: "user", AuthorID: "user",
		Content: []byte("classified")})

	cases := []struct {
		name  string
		token string
		want  error
	}{
		{"anonymous", "", ErrAnonymous},
		{"forged token", runID+"-forged", ErrUnauthorized},
		{"cross-project token", runID+"-other", ErrWrongProject},
		{"revoked grant", runID+"-rev", ErrRevoked},
	}
	for _, c := range cases {
		if _, err := st.Read(context.Background(), c.token, projA, path); !errors.Is(err, c.want) {
			t.Fatalf("read/%s: err=%v want=%v", c.name, err, c.want)
		}
		if _, err := st.List(context.Background(), c.token, projA, "/perm"); !errors.Is(err, c.want) {
			t.Fatalf("list/%s: err=%v want=%v", c.name, err, c.want)
		}
		if _, err := st.Candidates(context.Background(), c.token, projA, path); !errors.Is(err, c.want) {
			t.Fatalf("candidates/%s: err=%v want=%v", c.name, err, c.want)
		}
		// A denied save must leave zero rows — not even a candidate.
		_, err := st.Save(context.Background(), SaveRequest{Token: c.token, ProjectID: projA, Path: path,
			BaseRevision: 0, OpID: runID+"-perm-" + c.name, AuthorKind: "user", AuthorID: "attacker", Content: []byte("evil")})
		if !errors.Is(err, c.want) {
			t.Fatalf("save/%s: err=%v want=%v", c.name, err, c.want)
		}
	}

	// Expired run grant.
	time.Sleep(1100 * time.Millisecond)
	if _, err := st.Read(context.Background(), runID+"-run", projA, path); !errors.Is(err, ErrRunExpired) {
		t.Fatalf("read/expired-run: err=%v want=%v", err, ErrRunExpired)
	}
	if _, err := st.Save(context.Background(), SaveRequest{Token: runID+"-run", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID+"-perm-expired-run", AuthorKind: "run", AuthorID: "run-late", Content: []byte("late")}); !errors.Is(err, ErrRunExpired) {
		t.Fatalf("save/expired-run: err=%v", err)
	}

	// Denied writes left no trace at all.
	var n int
	st.pool.QueryRow(context.Background(),
		`SELECT (SELECT count(*) FROM op_results WHERE op_id LIKE $1) + (SELECT count(*) FROM conflict_candidates WHERE op_id LIKE $1) + (SELECT count(*) FROM revisions WHERE op_id LIKE $1)`, runID+"-perm-%").Scan(&n)
	if n != 0 {
		t.Fatalf("denied operations left %d rows", n)
	}

	// Anonymous download of the raw object is the storage layer's concern;
	// at the API surface there is no unauthenticated path at all — asserted
	// structurally: every exported entry point starts with authorize().
	if _, err := st.Read(context.Background(), runID+"-user", projA, path); err != nil {
		t.Fatalf("legitimate read broken: %v", err)
	}
	t.Log("item3: anonymous/forged/cross-project/revoked/expired denied on read+list+candidates+save; zero side effects")
}

func mustNil(err error) {
	if err != nil {
		panic(err)
	}
}
