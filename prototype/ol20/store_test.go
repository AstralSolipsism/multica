// Phase-0 acceptance tests, v2 (post-review). Items 1–3 from the original
// matrix plus the review-mandated regressions:
//   R1 same op key + different content  -> ErrOpKeyReused, never old outcome
//   R2 same op key + different project  -> scoped ledgers, both apply
//   R3 same op key + different actors   -> scoped ledgers, no cross-talk
//   R4 concurrent identical op          -> exactly one applies, other replays
//   R5 CONFLICT response lost           -> replay returns candidate id etc.
//   R6 grant revoked / run expired during upload -> commit re-check denies
//   R7 third-party update then adopt    -> adoption appends, never overwrites
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
	runID = fmt.Sprintf("r%d", time.Now().UnixNano())
	projA = "11111111-1111-1111-1111-111111111111"
	projB = "22222222-2222-2222-2222-222222222222"
	projC = "33333333-3333-3333-3333-333333333333"
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

// countRows runs a counting query and checks the Scan error (review P2-5).
func countRows(t *testing.T, st *Store, q string, args ...any) int {
	t.Helper()
	var n int
	if err := st.pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("count query failed: %v", err)
	}
	return n
}

func grant(t *testing.T, st *Store, token, project, actor string) {
	t.Helper()
	if err := st.Grant(context.Background(), token, project, "user", actor, nil); err != nil {
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

type racer struct {
	res SaveResult
	err error
}

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
	winner, loserContent, loserAuthor := contentA, contentB, "actor-b"
	if rb.res.Status == StatusSaved {
		winner, loserContent, loserAuthor = contentB, contentA, "actor-a"
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
	grant(t, st, runID+"-a", projA, "actor-a")
	grant(t, st, runID+"-b", projA, "actor-b")
	const rounds = 100
	for i := 0; i < rounds; i++ {
		path := fmt.Sprintf(runID+"/concurrent/text-%04d.md", i)
		if got := save(t, st, SaveRequest{Token: runID + "-a", ProjectID: projA, Path: path,
			BaseRevision: 0, OpID: fmt.Sprintf(runID+"-seed-t-%d", i),
			Content:      []byte(fmt.Sprintf("seed %d", i))}).Revision; got != 1 {
			t.Fatalf("round %d: seed revision = %d", i, got)
		}
		contentA := []byte(fmt.Sprintf("A-%d-%s", i, bytes.Repeat([]byte("x"), 512)))
		contentB := []byte(fmt.Sprintf("B-%d-%s", i, bytes.Repeat([]byte("y"), 700)))
		ra, rb := runRacingSaves(t,
			SaveRequest{Token: runID + "-a", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-ra-t-%d", i), Content: contentA},
			SaveRequest{Token: runID + "-b", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-rb-t-%d", i), Content: contentB})
		assertOneWinnerOneCandidate(t, i, path, runID+"-a", runID+"-b", ra, rb, contentA, contentB, st)
	}
	t.Logf("item1 text: %d rounds, 2 racers each — exactly one current, loser preserved, every round", rounds)
}

func TestItem1BinaryConcurrentSaves(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-a", projA, "actor-a")
	grant(t, st, runID+"-b", projA, "actor-b")
	const rounds = 100
	for i := 0; i < rounds; i++ {
		path := fmt.Sprintf(runID+"/concurrent/bin-%04d.dat", i)
		save(t, st, SaveRequest{Token: runID + "-a", ProjectID: projA, Path: path,
			BaseRevision: 0, OpID: fmt.Sprintf(runID+"-seed-b-%d", i), Content: make([]byte, 256)})
		bufA, bufB := make([]byte, 4096), make([]byte, 4096)
		rand.Read(bufA)
		rand.Read(bufB)
		ra, rb := runRacingSaves(t,
			SaveRequest{Token: runID + "-a", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-ra-b-%d", i), Content: bufA},
			SaveRequest{Token: runID + "-b", ProjectID: projA, Path: path, OpID: fmt.Sprintf(runID+"-rb-b-%d", i), Content: bufB})
		assertOneWinnerOneCandidate(t, i, path, runID+"-a", runID+"-b", ra, rb, bufA, bufB, st)
	}
	t.Logf("item1 binary: %d rounds, 4KB random per racer — one current, loser preserved, every round", rounds)
}

// ---------------------------------------------------------------------------
// Item 2 — failure injection; retries are idempotent and never fake success.
// ---------------------------------------------------------------------------

func TestItem2FailDuringUpload(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-u", projA, "actor-u")
	path := runID + "/failure/during-upload.md"
	st.FailDuringUpload = errors.New("injected: connection reset during upload")
	_, err := st.Save(context.Background(), SaveRequest{Token: runID + "-u", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-fdu-1", Content: []byte("v1")})
	if err == nil {
		t.Fatal("injected upload failure must surface as an error")
	}
	st.FailDuringUpload = nil

	n := countRows(t, st, `SELECT (SELECT count(*) FROM revisions WHERE op_id=$1)+(SELECT count(*) FROM op_results WHERE op_id=$1)+(SELECT count(*) FROM conflict_candidates WHERE op_id=$1)`, runID+"-fdu-1")
	if n != 0 {
		t.Fatalf("failed op left %d rows behind", n)
	}
	res := save(t, st, SaveRequest{Token: runID + "-u", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-fdu-1", Content: []byte("v1")})
	if res.Status != StatusSaved || res.Replayed {
		t.Fatalf("retry outcome = %+v", res)
	}
	if got := countRows(t, st, `SELECT count(*) FROM revisions WHERE op_id=$1`, runID+"-fdu-1"); got != 1 {
		t.Fatalf("retry created %d revision rows, want 1", got)
	}
	cur, err := st.Read(context.Background(), runID+"-u", projA, path)
	if err != nil || cur.Revision != 1 {
		t.Fatalf("current after retry: rev=%d err=%v", cur.Revision, err)
	}
	t.Log("item2a: upload interrupted -> error, zero rows, retry idempotent, current intact")
}

func TestItem2FailBetweenUploadAndCommit(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-u", projA, "actor-u")
	path := runID + "/failure/after-upload.md"
	orphansBefore, err := st.Orphans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	st.FailAfterUpload = errors.New("injected: crash after upload, before commit")
	_, err = st.Save(context.Background(), SaveRequest{Token: runID + "-u", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-fau-1", Content: []byte("v1")})
	if err == nil {
		t.Fatal("injected failure must surface")
	}
	st.FailAfterUpload = nil

	n := countRows(t, st, `SELECT (SELECT count(*) FROM revisions WHERE op_id=$1)+(SELECT count(*) FROM op_results WHERE op_id=$1)`, runID+"-fau-1")
	if n != 0 {
		t.Fatalf("rolled-back op left %d rows", n)
	}
	orphans, _ := st.Orphans(context.Background())
	if got := len(orphans) - len(orphansBefore); got != 1 {
		t.Fatalf("aborted round must leave exactly 1 new GC-able orphan, got %d", got)
	}
	res := save(t, st, SaveRequest{Token: runID + "-u", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-fau-1", Content: []byte("v1")})
	if res.Status != StatusSaved {
		t.Fatalf("retry = %+v", res)
	}
	if _, err := st.Read(context.Background(), runID+"-u", projA, path); err != nil {
		t.Fatalf("current points at missing object: %v", err)
	}
	if got := countRows(t, st, `SELECT count(*) FROM revisions r WHERE r.op_id=$1`, runID+"-fau-1"); got != 1 {
		t.Fatalf("retry produced %d revision rows for this op", got)
	}
	t.Log("item2b: MinIO ok + DB uncommitted -> 0 rows, 1 GC-able orphan, retry idempotent")
}

func TestItem2FailAfterCommitResponseLost(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-u", projA, "actor-u")
	path := runID + "/failure/response-lost.md"
	st.FailAfterCommit = errors.New("injected: response lost after commit")
	res, err := st.Save(context.Background(), SaveRequest{Token: runID + "-u", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-frc-1", Content: []byte("v1")})
	if err == nil {
		t.Fatal("caller must see an error even though the commit succeeded")
	}
	st.FailAfterCommit = nil
	if res.Status != StatusSaved {
		t.Fatalf("internal result after commit = %+v", res)
	}
	retry := save(t, st, SaveRequest{Token: runID + "-u", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-frc-1", Content: []byte("v1")})
	if retry.Status != StatusSaved || !retry.Replayed || retry.Revision != 1 {
		t.Fatalf("retry must replay the recorded outcome: %+v", retry)
	}
	if got := countRows(t, st, `SELECT count(*) FROM revisions WHERE op_id=$1`, runID+"-frc-1"); got != 1 {
		t.Fatalf("replayed op created %d revision rows, want 1", got)
	}
	t.Log("item2c: commit ok + response lost -> retry replays outcome, no duplicate")
}

// ---------------------------------------------------------------------------
// Item 3 — one permission gate across every entry point.
// ---------------------------------------------------------------------------

func TestItem3PermissionsCoverAllEntryPoints(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-user", projA, "actor-user")
	grant(t, st, runID+"-other", projB, "actor-other")
	exp := time.Now().Add(1 * time.Second)
	if err := st.Grant(context.Background(), runID+"-run", projA, "run", "actor-run", &exp); err != nil {
		t.Fatal(err)
	}
	grant(t, st, runID+"-rev", projA, "actor-rev")
	if err := st.Revoke(context.Background(), runID+"-rev"); err != nil {
		t.Fatal(err)
	}

	path := runID + "/perm/secret.md"
	save(t, st, SaveRequest{Token: runID + "-user", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-permseed-ok", Content: []byte("classified")})

	cases := []struct {
		name  string
		token string
		want  error
	}{
		{"anonymous", "", ErrAnonymous},
		{"forged token", runID + "-forged", ErrUnauthorized},
		{"cross-project token", runID + "-other", ErrWrongProject},
		{"revoked grant", runID + "-rev", ErrRevoked},
	}
	for _, c := range cases {
		if _, err := st.Read(context.Background(), c.token, projA, path); !errors.Is(err, c.want) {
			t.Fatalf("read/%s: err=%v want=%v", c.name, err, c.want)
		}
		if _, err := st.List(context.Background(), c.token, projA, runID+"/perm"); !errors.Is(err, c.want) {
			t.Fatalf("list/%s: err=%v want=%v", c.name, err, c.want)
		}
		if _, err := st.Candidates(context.Background(), c.token, projA, path); !errors.Is(err, c.want) {
			t.Fatalf("candidates/%s: err=%v want=%v", c.name, err, c.want)
		}
		_, err := st.Save(context.Background(), SaveRequest{Token: c.token, ProjectID: projA, Path: path,
			BaseRevision: 0, OpID: runID + "-perm-" + c.name, Content: []byte("evil")})
		if !errors.Is(err, c.want) {
			t.Fatalf("save/%s: err=%v want=%v", c.name, err, c.want)
		}
	}

	time.Sleep(1100 * time.Millisecond)
	if _, err := st.Read(context.Background(), runID+"-run", projA, path); !errors.Is(err, ErrRunExpired) {
		t.Fatalf("read/expired-run: err=%v want=%v", err, ErrRunExpired)
	}
	if _, err := st.Save(context.Background(), SaveRequest{Token: runID + "-run", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-perm-expired-run", Content: []byte("late")}); !errors.Is(err, ErrRunExpired) {
		t.Fatalf("save/expired-run: err=%v", err)
	}
	if _, err := st.List(context.Background(), runID+"-run", projA, "/"); !errors.Is(err, ErrRunExpired) {
		t.Fatalf("list/expired-run: err=%v", err)
	}
	if _, err := st.Candidates(context.Background(), runID+"-run", projA, path); !errors.Is(err, ErrRunExpired) {
		t.Fatalf("candidates/expired-run: err=%v", err)
	}

	n := countRows(t, st, `SELECT (SELECT count(*) FROM op_results WHERE op_id LIKE $1)+(SELECT count(*) FROM conflict_candidates WHERE op_id LIKE $1)+(SELECT count(*) FROM revisions WHERE op_id LIKE $1)`, runID+"-perm-%")
	if n != 0 {
		t.Fatalf("denied operations left %d rows", n)
	}
	if _, err := st.Read(context.Background(), runID+"-user", projA, path); err != nil {
		t.Fatalf("legitimate read broken: %v", err)
	}
	t.Log("item3: anonymous/forged/cross-project/revoked/expired denied on read+list+candidates+save; zero side effects")
}

// ---------------------------------------------------------------------------
// Review regressions R1–R7.
// ---------------------------------------------------------------------------

// R1: the same (project, actor, op) reused for different content must be an
// explicit error, never a replay of the old outcome (P1-1 counterexample).
func TestR1SameOpKeyDifferentContentRejected(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r1", projA, "actor-r1")
	path := runID + "/r1/a.md"
	res := save(t, st, SaveRequest{Token: runID + "-r1", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-r1-op", Content: []byte("original")})
	if res.Status != StatusSaved {
		t.Fatalf("first save = %+v", res)
	}
	_, err := st.Save(context.Background(), SaveRequest{Token: runID + "-r1", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: runID + "-r1-op", Content: []byte("different content")})
	if !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("same key + different request: err=%v want ErrOpKeyReused", err)
	}
	// Same key, different path — also a different request.
	_, err = st.Save(context.Background(), SaveRequest{Token: runID + "-r1", ProjectID: projA, Path: runID + "/r1/b.md",
		BaseRevision: 0, OpID: runID + "-r1-op", Content: []byte("other file")})
	if !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("same key + different path: err=%v want ErrOpKeyReused", err)
	}
	// The rejected attempts must not have side effects.
	if n := countRows(t, st, `SELECT count(*) FROM files WHERE project_id=$1 AND path=$2`, projA, runID+"/r1/b.md"); n != 0 {
		t.Fatalf("rejected save created the file anyway (%d)", n)
	}
	t.Log("R1: same op key + different content/path -> explicit ErrOpKeyReused, zero side effects")
}

// R2: the same op id under a different project is a different scope: both
// apply independently — B must NOT receive A's SAVED replay (P1-1 fix).
func TestR2SameOpKeyDifferentProjectAppliesIndependently(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r2a", projA, "actor-r2a")
	grant(t, st, runID+"-r2b", projB, "actor-r2b")
	op := runID + "-r2-op"
	resA := save(t, st, SaveRequest{Token: runID + "-r2a", ProjectID: projA, Path: "/x.md",
		BaseRevision: 0, OpID: op, Content: []byte("A content")})
	if !resA.Replayed && resA.Status != StatusSaved {
		t.Fatalf("A save = %+v", resA)
	}
	resB := save(t, st, SaveRequest{Token: runID + "-r2b", ProjectID: projB, Path: "/x.md",
		BaseRevision: 0, OpID: op, Content: []byte("B content")})
	if resB.Replayed {
		t.Fatal("B must not replay A's outcome — its file was never saved")
	}
	if resB.Status != StatusSaved || resB.Revision != 1 {
		t.Fatalf("B save = %+v", resB)
	}
	curB, err := st.Read(context.Background(), runID+"-r2b", projB, "/x.md")
	if err != nil || !bytes.Equal(curB.Content, []byte("B content")) {
		t.Fatalf("B file content wrong: %v", err)
	}
	t.Log("R2: same op id across projects -> scoped ledgers, both files really saved")
}

// R3: the same op id used by two different actors is two scoped keys.
func TestR3SameOpKeyDifferentActors(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r3a", projA, "actor-r3a")
	grant(t, st, runID+"-r3b", projA, "actor-r3b")
	path := "/r3.md"
	op := runID + "-r3-op"
	resA := save(t, st, SaveRequest{Token: runID + "-r3a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: op, Content: []byte("from A")})
	resB := save(t, st, SaveRequest{Token: runID + "-r3b", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: op, Content: []byte("from B on top")})
	if resA.Status != StatusSaved || resA.Replayed {
		t.Fatalf("A = %+v", resA)
	}
	if resB.Status != StatusSaved || resB.Replayed || resB.Revision != 2 {
		t.Fatalf("B must apply its own scoped key: %+v", resB)
	}
	// A's author attribution must be A's, B's B's (P1-2).
	var authors []string
	rows, err := st.pool.Query(context.Background(),
		`SELECT author_id FROM revisions r JOIN files f ON f.id=r.file_id WHERE f.project_id=$1 AND f.path=$2 ORDER BY r.revision`, projA, path)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			t.Fatal(err)
		}
		authors = append(authors, a)
	}
	rows.Close()
	if len(authors) != 2 || authors[0] != "actor-r3a" || authors[1] != "actor-r3b" {
		t.Fatalf("author attribution = %v", authors)
	}
	t.Log("R3: same op id across actors -> scoped keys, correct author attribution from grants")
}

// R4: two concurrent saves sharing one identical request: exactly one
// applies, the other replays; no duplicate rows, no double object identity.
func TestR4ConcurrentIdenticalOp(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r4", projA, "actor-r4")
	req := SaveRequest{Token: runID + "-r4", ProjectID: projA, Path: runID + "/r4.md",
		BaseRevision: 0, OpID: runID + "-r4-op", Content: []byte("identical request")}

	ctx := context.Background()
	stA, _ := OpenStore(ctx, pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	defer stA.Close()
	stB, _ := OpenStore(ctx, pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	defer stB.Close()

	start := make(chan struct{})
	var out [2]SaveResult
	var errs [2]error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); <-start; out[0], errs[0] = stA.Save(ctx, req) }()
	go func() { defer wg.Done(); <-start; out[1], errs[1] = stB.Save(ctx, req) }()
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("racer %d: %v", i, err)
		}
	}
	applied, replayed := 0, 0
	for _, r := range out {
		if r.Replayed {
			replayed++
		} else {
			applied++
		}
		if r.Status != StatusSaved || r.Revision != 1 {
			t.Fatalf("outcome = %+v", r)
		}
	}
	if applied != 1 || replayed != 1 {
		t.Fatalf("applied=%d replayed=%d, want 1/1", applied, replayed)
	}
	if n := countRows(t, st, `SELECT count(*) FROM revisions WHERE op_id=$1`, runID+"-r4-op"); n != 1 {
		t.Fatalf("%d revision rows", n)
	}
	if n := countRows(t, st, `SELECT count(*) FROM op_results WHERE op_id=$1`, runID+"-r4-op"); n != 1 {
		t.Fatalf("%d ledger rows", n)
	}
	t.Log("R4: concurrent identical op -> one applies, one replays, single row set")
}

// R5: CONFLICT response lost -> retry replays the COMPLETE outcome including
// candidate id and current revision at conflict (P2-3).
func TestR5ConflictReplayComplete(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r5a", projA, "actor-r5a")
	grant(t, st, runID+"-r5b", projA, "actor-r5b")
	path := runID + "/r5.md"
	save(t, st, SaveRequest{Token: runID + "-r5a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-r5-seed", Content: []byte("v1")})
	save(t, st, SaveRequest{Token: runID + "-r5a", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: runID + "-r5-v2", Content: []byte("v2 by A")})

	st.FailAfterCommit = errors.New("injected: conflict response lost")
	res, err := st.Save(context.Background(), SaveRequest{Token: runID + "-r5b", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: runID + "-r5-b1", Content: []byte("stale save by B")})
	if err == nil {
		t.Fatal("caller must see the injected error")
	}
	st.FailAfterCommit = nil
	if res.Status != StatusConflict || res.CandidateID == "" || res.ConflictCurrent != 2 {
		t.Fatalf("conflict result incomplete: %+v", res)
	}

	retry := save(t, st, SaveRequest{Token: runID + "-r5b", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: runID + "-r5-b1", Content: []byte("stale save by B")})
	if !retry.Replayed || retry.Status != StatusConflict || retry.CandidateID != res.CandidateID || retry.ConflictCurrent != 2 || retry.Revision != res.Revision {
		t.Fatalf("conflict replay incomplete: first=%+v retry=%+v", res, retry)
	}
	if n := countRows(t, st, `SELECT count(*) FROM conflict_candidates WHERE id=$1`, res.CandidateID); n != 1 {
		t.Fatalf("%d candidate rows", n)
	}
	t.Logf("R5: conflict replay identical incl. Revision=%d (candidate=%s)", res.Revision, res.CandidateID[:8])
}

// R6: grant revoked / run expired DURING the upload -> the commit-time
// re-check denies; nothing persists (P1-2).
func TestR6RevokedDuringUpload(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r6", projA, "actor-r6")
	path := runID + "/r6.md"

	st.InterludeDuringUpload = func() {
		if err := st.Revoke(context.Background(), runID+"-r6"); err != nil {
			t.Errorf("revoke in interlude: %v", err)
		}
	}
	_, err := st.Save(context.Background(), SaveRequest{Token: runID + "-r6", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-r6-op", Content: []byte("should not persist")})
	st.InterludeDuringUpload = nil
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked mid-upload: err=%v want ErrRevoked", err)
	}
	if n := countRows(t, st, `SELECT (SELECT count(*) FROM revisions WHERE op_id=$1)+(SELECT count(*) FROM op_results WHERE op_id=$1)`, runID+"-r6-op"); n != 0 {
		t.Fatalf("mid-upload revocation left %d rows", n)
	}
	if _, err := st.Read(context.Background(), runID+"-r6", projA, path); !errors.Is(err, ErrRevoked) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("post-revoke read: %v", err)
	}
	t.Log("R6a: grant revoked during upload -> commit re-check denies, zero rows")
}

func TestR6RunExpiredDuringUpload(t *testing.T) {
	st := open(t)
	exp := time.Now().Add(1 * time.Second)
	if err := st.Grant(context.Background(), runID+"-r6run", projA, "run", "actor-r6run", &exp); err != nil {
		t.Fatal(err)
	}
	path := runID + "/r6run.md"
	st.InterludeDuringUpload = func() {
		time.Sleep(1200 * time.Millisecond) // let the run grant lapse mid-upload
	}
	_, err := st.Save(context.Background(), SaveRequest{Token: runID + "-r6run", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-r6run-op", Content: []byte("late")})
	st.InterludeDuringUpload = nil
	if !errors.Is(err, ErrRunExpired) {
		t.Fatalf("expired mid-upload: err=%v want ErrRunExpired", err)
	}
	if n := countRows(t, st, `SELECT (SELECT count(*) FROM revisions WHERE op_id=$1)+(SELECT count(*) FROM op_results WHERE op_id=$1)`, runID+"-r6run-op"); n != 0 {
		t.Fatalf("mid-upload expiry left %d rows", n)
	}
	t.Log("R6b: run expired during upload -> commit re-check denies, zero rows")
}

// R7: a candidate created against an old base is adopted AFTER a third party
// moved current forward: adoption appends a new revision and never
// overwrites the third party's content (review's third-party test).
func TestR7AdoptAfterThirdPartyUpdate(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r7a", projA, "actor-r7a")
	grant(t, st, runID+"-r7b", projA, "actor-r7b")
	grant(t, st, runID+"-r7c", projA, "actor-r7c")
	path := runID + "/r7.md"

	save(t, st, SaveRequest{Token: runID + "-r7a", ProjectID: projA, Path: path,
		BaseRevision: 0, OpID: runID + "-r7-v1", Content: []byte("v1")})
	// A keeps working on base 1...
	stale := []byte("A's rework based on v1")
	// ...B moves current to v2, then C to v3.
	save(t, st, SaveRequest{Token: runID + "-r7b", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: runID + "-r7-v2", Content: []byte("v2 by B")})
	save(t, st, SaveRequest{Token: runID + "-r7c", ProjectID: projA, Path: path,
		BaseRevision: 2, OpID: runID + "-r7-v3", Content: []byte("v3 by C")})
	// A's stale save lands as a candidate.
	res := save(t, st, SaveRequest{Token: runID + "-r7a", ProjectID: projA, Path: path,
		BaseRevision: 1, OpID: runID + "-r7-stale", Content: stale})
	if res.Status != StatusConflict {
		t.Fatalf("stale save = %+v", res)
	}

	// Adopt A's candidate now, decided against the head it reviewed (rev 3).
	adopt := save2(t, st, func() (SaveResult, error) {
		return st.AdoptCandidate(context.Background(), runID+"-r7a", projA, path, res.CandidateID, runID+"-r7-adopt", 3)
	})
	if adopt.Status != StatusSaved || adopt.Revision != 4 {
		t.Fatalf("adopt = %+v, want SAVED rev4", adopt)
	}
	cur, err := st.Read(context.Background(), runID+"-r7a", projA, path)
	if err != nil || !bytes.Equal(cur.Content, stale) {
		t.Fatalf("current after adopt = %q err=%v", cur.Content, err)
	}
	// C's v3 must survive in history.
	v3, err := st.RevisionContent(context.Background(), runID+"-r7c", projA, path, 3)
	if err != nil || !bytes.Equal(v3, []byte("v3 by C")) {
		t.Fatalf("third party v3 lost: %v", err)
	}
	// The adopted candidate is consumed.
	cands, err := st.Candidates(context.Background(), runID+"-r7a", projA, path)
	if err != nil || len(cands) != 0 {
		t.Fatalf("candidate not consumed: %v (%d)", err, len(cands))
	}
	// Adopt replay (same op) returns the same revision without a new row.
	adopt2 := save2(t, st, func() (SaveResult, error) {
		return st.AdoptCandidate(context.Background(), runID+"-r7a", projA, path, res.CandidateID, runID+"-r7-adopt", 3)
	})
	// The candidate row is gone; replay must NOT fail with not-found — it
	// replays from the ledger.
	if !adopt2.Replayed || adopt2.Revision != 4 {
		t.Fatalf("adopt replay = %+v", adopt2)
	}
	if n := countRows(t, st, `SELECT count(*) FROM revisions WHERE op_id=$1`, runID+"-r7-adopt"); n != 1 {
		t.Fatalf("adopt rows = %d", n)
	}
	t.Log("R7: adopt after third-party update appends rev4, v3 preserved in history, candidate consumed, adopt idempotent")
}

// R8: adoption decided against a stale head -> conflict, head and candidate
// both preserved, nothing consumed (architect P1 window).
func TestR8AdoptStaleExpectedRevisionConflicts(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r8a", projA, "actor-r8a")
	grant(t, st, runID+"-r8b", projA, "actor-r8b")
	path := runID + "/r8.md"
	save(t, st, SaveRequest{Token: runID + "-r8a", ProjectID: projA, Path: path, BaseRevision: 0, OpID: runID + "-r8-v1", Content: []byte("v1")})
	// Head moves to rev 2; A's write based on rev 1 becomes a candidate.
	save(t, st, SaveRequest{Token: runID + "-r8b", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r8-v2", Content: []byte("v2 by B")})
	res := save(t, st, SaveRequest{Token: runID + "-r8a", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r8-stale", Content: []byte("A on v1")})
	if res.Status != StatusConflict {
		t.Fatalf("setup = %+v", res)
	}
	// Adoption decided against the reviewed head (rev 2); a third party
	// commits rev 3 inside the decision window.
	save(t, st, SaveRequest{Token: runID + "-r8b", ProjectID: projA, Path: path, BaseRevision: 2, OpID: runID + "-r8-v3", Content: []byte("v3 by B")})

	adopt := save2(t, st, func() (SaveResult, error) {
		return st.AdoptCandidate(context.Background(), runID+"-r8a", projA, path, res.CandidateID, runID+"-r8-adopt", 2)
	})
	if adopt.Status != StatusConflict || adopt.Revision != 3 {
		t.Fatalf("stale adopt = %+v, want CONFLICT at head 3", adopt)
	}
	cur, err := st.Read(context.Background(), runID+"-r8a", projA, path)
	if err != nil || cur.Revision != 3 || !bytes.Equal(cur.Content, []byte("v3 by B")) {
		t.Fatalf("head changed by stale adopt: rev=%d err=%v", cur.Revision, err)
	}
	if n := countRows(t, st, `SELECT count(*) FROM conflict_candidates WHERE id=$1`, res.CandidateID); n != 1 {
		t.Fatalf("candidate consumed by stale adopt (n=%d)", n)
	}
	if n := countRows(t, st, `SELECT count(*) FROM op_results WHERE op_id=$1`, runID+"-r8-adopt"); n != 0 {
		t.Fatalf("stale adopt left %d ledger rows", n)
	}
	// Re-decide at the real head (fresh op id): adoption succeeds as rev 4.
	adopt2 := save2(t, st, func() (SaveResult, error) {
		return st.AdoptCandidate(context.Background(), runID+"-r8a", projA, path, res.CandidateID, runID+"-r8-adopt2", 3)
	})
	if adopt2.Status != StatusSaved || adopt2.Revision != 4 {
		t.Fatalf("re-decided adopt = %+v", adopt2)
	}
	t.Log("R8: stale expectedRevision -> conflict, head+candidate preserved, re-decide at real head succeeds")
}

// R9: adopt replay binding — same key with a different candidate or expected
// revision, or a key that served a Save, is ErrOpKeyReused; concurrent
// identical adopts resolve to apply+replay, never NotFound.
func TestR9AdoptReplayBindingAndConcurrency(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r9a", projA, "actor-r9a")
	grant(t, st, runID+"-r9b", projA, "actor-r9b")
	path := runID + "/r9.md"
	save(t, st, SaveRequest{Token: runID + "-r9a", ProjectID: projA, Path: path, BaseRevision: 0, OpID: runID + "-r9-v1", Content: []byte("v1")})
	// Head to rev 2, then two stale writers produce two candidates.
	save(t, st, SaveRequest{Token: runID + "-r9b", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r9-v2", Content: []byte("v2")})
	c1 := save(t, st, SaveRequest{Token: runID + "-r9a", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r9-c1", Content: []byte("cand one")})
	c2 := save(t, st, SaveRequest{Token: runID + "-r9b", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r9-c2", Content: []byte("cand two")})
	if c1.Status != StatusConflict || c2.Status != StatusConflict {
		t.Fatalf("setup: %+v %+v", c1, c2)
	}

	if _, err := st.AdoptCandidate(context.Background(), runID+"-r9a", projA, path, c1.CandidateID, runID+"-r9-op", 2); err != nil {
		t.Fatalf("first adopt: %v", err)
	}
	_, err := st.AdoptCandidate(context.Background(), runID+"-r9a", projA, path, c2.CandidateID, runID+"-r9-op", 2)
	if !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("same key + different candidate: err=%v want ErrOpKeyReused", err)
	}
	_, err = st.AdoptCandidate(context.Background(), runID+"-r9a", projA, path, c1.CandidateID, runID+"-r9-op", 3)
	if !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("same key + different expected: err=%v want ErrOpKeyReused", err)
	}
	// A key that previously served a Save must never replay as adopt success.
	_, err = st.AdoptCandidate(context.Background(), runID+"-r9a", projA, path, c2.CandidateID, runID+"-r9-v1", 3)
	if !errors.Is(err, ErrOpKeyReused) {
		t.Fatalf("Save key reused by adopt: err=%v want ErrOpKeyReused", err)
	}

	// Concurrent identical adopts: exactly one applies, the other replays
	// (not NotFound — the winner already consumed the candidate).
	path2 := runID + "/r9b.md"
	save(t, st, SaveRequest{Token: runID + "-r9a", ProjectID: projA, Path: path2, BaseRevision: 0, OpID: runID + "-r9-s2", Content: []byte("v1")})
	save(t, st, SaveRequest{Token: runID + "-r9b", ProjectID: projA, Path: path2, BaseRevision: 1, OpID: runID + "-r9-s2v2", Content: []byte("v2")})
	c3 := save(t, st, SaveRequest{Token: runID + "-r9b", ProjectID: projA, Path: path2, BaseRevision: 1, OpID: runID + "-r9-c3", Content: []byte("cand three")})
	if c3.Status != StatusConflict {
		t.Fatalf("setup2: %+v", c3)
	}
	ctx := context.Background()
	stA, _ := OpenStore(ctx, pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	defer stA.Close()
	stB, _ := OpenStore(ctx, pgURL, s3EP, s3Key, s3Sec, bkt, "us-east-1")
	defer stB.Close()
	start := make(chan struct{})
	var out [2]SaveResult
	var errs [2]error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); <-start; out[0], errs[0] = stA.AdoptCandidate(ctx, runID+"-r9a", projA, path2, c3.CandidateID, runID+"-r9-adopt-par", 2) }()
	go func() { defer wg.Done(); <-start; out[1], errs[1] = stB.AdoptCandidate(ctx, runID+"-r9a", projA, path2, c3.CandidateID, runID+"-r9-adopt-par", 2) }()
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("racer %d: %v (must be apply or replay, never NotFound)", i, err)
		}
	}
	applied, replayed := 0, 0
	for _, r := range out {
		if r.Status != StatusSaved || r.Revision != 3 {
			t.Fatalf("outcome = %+v", r)
		}
		if r.Replayed {
			replayed++
		} else {
			applied++
		}
	}
	if applied != 1 || replayed != 1 {
		t.Fatalf("applied=%d replayed=%d", applied, replayed)
	}
	t.Log("R9: adopt replay bound to kind+candidate+expected; Save keys not hijackable; concurrent adopt = apply+replay")
}

// R10: grant revoked during the adopt window (lock wait / object read) ->
// commit re-check denies, nothing persists, candidate intact.
func TestR10RevokedDuringAdopt(t *testing.T) {
	st := open(t)
	grant(t, st, runID+"-r10", projA, "actor-r10")
	path := runID + "/r10.md"
	save(t, st, SaveRequest{Token: runID + "-r10", ProjectID: projA, Path: path, BaseRevision: 0, OpID: runID + "-r10-v1", Content: []byte("v1")})
	save(t, st, SaveRequest{Token: runID + "-r10", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r10-v2", Content: []byte("v2")})
	res := save(t, st, SaveRequest{Token: runID + "-r10", ProjectID: projA, Path: path, BaseRevision: 1, OpID: runID + "-r10-stale", Content: []byte("stale")})
	if res.Status != StatusConflict {
		t.Fatalf("setup = %+v", res)
	}
	st.InterludeDuringAdopt = func() {
		if err := st.Revoke(context.Background(), runID + "-r10"); err != nil {
			t.Errorf("revoke: %v", err)
		}
	}
	_, err := st.AdoptCandidate(context.Background(), runID+"-r10", projA, path, res.CandidateID, runID + "-r10-adopt", 2)
	st.InterludeDuringAdopt = nil
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked mid-adopt: err=%v want ErrRevoked", err)
	}
	if n := countRows(t, st, `SELECT (SELECT count(*) FROM revisions WHERE op_id=$1)+(SELECT count(*) FROM op_results WHERE op_id=$1)`, runID+"-r10-adopt"); n != 0 {
		t.Fatalf("mid-adopt revocation left %d rows", n)
	}
	if n := countRows(t, st, `SELECT count(*) FROM conflict_candidates WHERE id=$1`, res.CandidateID); n != 1 {
		t.Fatalf("candidate consumed despite revocation (n=%d)", n)
	}
	t.Log("R10: revoked during adopt -> commit re-check denies, zero rows, candidate intact")
}

func save2(t *testing.T, st *Store, f func() (SaveResult, error)) SaveResult {
	t.Helper()
	res, err := f()
	if err != nil {
		t.Fatalf("op: %v", err)
	}
	return res
}
