package handler

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type labrastroObserveBeginStarter struct {
	txStarter
	observe func(context.Context)
}

func (s labrastroObserveBeginStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	s.observe(ctx)
	return s.txStarter.Begin(ctx)
}

func labrastroRawRequests(f *labrastroSourceFixture, from int) int {
	n := 0
	for _, p := range f.paths[from:] {
		if strings.HasPrefix(p, "/"+f.Owner+"/"+f.Repo+"/") {
			n++
		}
	}
	return n
}

// These probes exercise the production 45-second handler budget. Every fake
// GitHub request (including API/commit/tree reads) pays the configured delay.
func TestLabrastroPackageCacheLatency(t *testing.T) {
	if os.Getenv("LABRASTRO_PACKAGE_LATENCY_TEST") != "1" {
		t.Skip("set LABRASTRO_PACKAGE_LATENCY_TEST=1 for real 45-second offline probes")
	}
	if importFetchTimeout != 45*time.Second {
		t.Fatalf("source budget changed: %s", importFetchTimeout)
	}
	t.Run("pinned_preview_and_warm_apply", func(t *testing.T) {
		fx := labrastroPackageDBFixture(t)
		f := labrastroReadSourceFixture(t, "mattpocock")
		f.delay = 250 * time.Millisecond
		f.install(t)
		before := labrastroPackageSnapshotHash(t, fx)
		start := time.Now()
		preview := labrastroPreview(t, fx, testUserID, f.url())
		previewElapsed, previewRequests := time.Since(start), f.requests
		if len(preview.Candidates) != 37 || before != labrastroPackageSnapshotHash(t, fx) {
			t.Fatal("preview output/readonly boundary changed")
		}
		start = time.Now()
		report := labrastroApply(t, fx, testUserID, f.url(), preview.PreviewID, nil)
		elapsed, raw := time.Since(start), labrastroRawRequests(f, previewRequests)
		if report.Failed || len(report.Results) != 37 || raw != 0 {
			t.Fatalf("warm apply: %+v raw=%d", report, raw)
		}
		if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 27 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 27 {
			t.Fatal("report did not match default selection/DB")
		}
		if elapsed > 10*time.Second {
			t.Fatalf("warm apply took %s", elapsed)
		}
		t.Logf("delay=%s preview=%s requests=%d raw=%d apply=%s requests=%d raw=%d peak_downloads=%d skills=27 placements=27 report=37", f.delay, previewElapsed, previewRequests, labrastroRawRequests(f, 0)-raw, elapsed, f.requests-previewRequests, raw, f.maxActive)
	})
	t.Run("timeout_then_cached_retry", func(t *testing.T) {
		fx := labrastroPackageDBFixture(t)
		files := map[string]string{}
		for i := 0; i < 180; i++ {
			files[fmt.Sprintf("skills/%03d/SKILL.md", i)] = fmt.Sprintf("---\nname: skill-%03d\n---\nbody %d", i, i)
		}
		f := labrastroTestFixture(files)
		f.delay = time.Second
		f.install(t)
		before := labrastroPackageSnapshotHash(t, fx)
		start := time.Now()
		var failure struct {
			Code string `json:"code"`
		}
		labrastroCall(t, fx, testUserID, testHandler.LabrastroPreviewPackage, "POST", map[string]any{"url": f.url()}).Want(504).JSON(&failure)
		first, requests, raw := time.Since(start), f.requests, labrastroRawRequests(f, 0)
		if failure.Code != "source_timeout" || first < 44*time.Second || before != labrastroPackageSnapshotHash(t, fx) {
			t.Fatalf("timeout boundary: %s %s", failure.Code, first)
		}
		cache := labrastroPackageBlobs
		cache.mu.Lock()
		cached, cacheBytes := 0, 0
		for key, e := range cache.entries {
			if key.workspace == fx.WorkspaceID {
				cached++
				cacheBytes += len(e.Value.(labrastroCachedBlob).body)
			}
		}
		cache.mu.Unlock()
		if cached == 0 || cached >= 180 {
			t.Fatalf("expected partial cache, got %d", cached)
		}
		start = time.Now()
		preview := labrastroPreview(t, fx, testUserID, f.url())
		second, retryRaw := time.Since(start), labrastroRawRequests(f, requests)
		if len(preview.Candidates) != 180 || retryRaw != 180-cached || before != labrastroPackageSnapshotHash(t, fx) {
			t.Fatalf("retry did not reuse completed blobs: candidates=%d cached=%d raw=%d", len(preview.Candidates), cached, retryRaw)
		}
		for _, c := range preview.Candidates {
			if c.State != "new" {
				t.Fatalf("retry left failed candidate: %+v", c)
			}
		}
		t.Logf("delay=%s first=%s requests=%d raw=%d cached=%d cache_bytes=%d retry=%s requests=%d raw=%d peak_downloads=%d database_unchanged=true", f.delay, first, requests, raw, cached, cacheBytes, second, f.requests-requests, retryRaw, f.maxActive)
	})
	t.Run("write_deadline_complete_report", func(t *testing.T) {
		fx := labrastroPackageDBFixture(t)
		f := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "alpha", "skills/beta/SKILL.md": "beta", "skills/zulu/SKILL.md": "zulu"})
		f.delay = 20 * time.Millisecond
		f.install(t)
		preview := labrastroPreview(t, fx, testUserID, f.url())
		h := *testHandler
		var writeCtx context.Context
		begins, commits := 0, 0
		h.TxStarter = labrastroAfterCommitStarter{labrastroObserveBeginStarter{h.TxStarter, func(ctx context.Context) { begins++; writeCtx = ctx }}, func() {
			commits++
			if commits == 2 {
				<-writeCtx.Done()
			}
		}}
		req := newRequestAsUser(testUserID, "POST", "/api/skill-packages", map[string]any{"url": f.url(), "preview_id": preview.PreviewID, "all": true})
		req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
		start, requests := time.Now(), f.requests
		var report LabrastroPackageApplyResult
		testutil.Call(t, h.LabrastroApplyPackage, req).Want(200).JSON(&report)
		elapsed := time.Since(start)
		if elapsed < 44*time.Second || !report.Failed || len(report.Results) != 3 || begins != 2 || commits != 2 || report.Results[0].Status != "created" {
			t.Fatalf("incomplete report after %s: %+v begins=%d commits=%d", elapsed, report, begins, commits)
		}
		for _, item := range report.Results[1:] {
			if item.Status != "failed" || item.Code != "source_timeout" || !item.Retryable {
				t.Fatalf("missing timeout item: %+v", item)
			}
		}
		if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 1 {
			t.Fatal("partial report/DB mismatch")
		}
		t.Logf("delay=%s elapsed=%s requests=%d raw=%d begins=%d commits=%d skills=1 placements=1 report=3 created=1 timeout=2", f.delay, elapsed, f.requests-requests, labrastroRawRequests(f, requests), begins, commits)
	})
}
