package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func labrastroTestBlobKey(body string) labrastroBlobKey {
	return labrastroBlobKey{"workspace", "owner/repo", labrastroGitBlobSHA([]byte(body))}
}

func TestLabrastroBlobCacheIdentityAndFailures(t *testing.T) {
	c := newLabrastroBlobCache(1024, time.Minute)
	key := labrastroTestBlobKey("body")
	calls := 0
	load := func() ([]byte, error) { calls++; return []byte("body"), nil }
	for i := 0; i < 2; i++ {
		body, err := c.get(t.Context(), key, load)
		if err != nil || string(body) != "body" {
			t.Fatalf("get: %q %v", body, err)
		}
	}
	if calls != 1 {
		t.Fatalf("cache hit downloaded again: %d", calls)
	}
	other := key
	other.workspace = "other"
	if _, err := c.get(t.Context(), other, load); err != nil {
		t.Fatal(err)
	}
	other.repository = "different/repo"
	if _, err := c.get(t.Context(), other, load); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("cache crossed workspace/repository boundaries: %d", calls)
	}
	bad := labrastroTestBlobKey("expected")
	for i := 0; i < 2; i++ {
		if body, err := c.get(t.Context(), bad, load); err == nil || body != nil {
			t.Fatal("hash mismatch accepted")
		}
	}
	if calls != 5 || c.entries[bad] != nil {
		t.Fatal("hash mismatch entered cache")
	}
	for i := 0; i < 2; i++ {
		_, err := c.get(t.Context(), bad, func() ([]byte, error) { calls++; return nil, errors.New("offline") })
		if err == nil {
			t.Fatal("download failure accepted")
		}
	}
	if calls != 7 || c.entries[bad] != nil || len(c.flights) != 0 {
		t.Fatal("failed flight was retained")
	}
}

func TestLabrastroBlobCacheLRUBytesAndTTL(t *testing.T) {
	now := time.Unix(1000, 0)
	c := newLabrastroBlobCache(4, time.Minute)
	c.now = func() time.Time { return now }
	calls := 0
	get := func(body string) {
		t.Helper()
		got, err := c.get(t.Context(), labrastroTestBlobKey(body), func() ([]byte, error) { calls++; return []byte(body), nil })
		if err != nil || string(got) != body {
			t.Fatalf("get: %q %v", got, err)
		}
		if c.bytes > c.maxBytes {
			t.Fatal("byte budget exceeded")
		}
	}
	get("aa")
	get("bb")
	get("aa")
	get("cc")
	if calls != 3 || c.bytes != 4 || c.entries[labrastroTestBlobKey("bb")] != nil {
		t.Fatal("LRU did not evict least recently read blob")
	}
	get("oversized")
	get("oversized")
	if calls != 5 || c.bytes != 4 {
		t.Fatal("oversized blob displaced or entered cache")
	}
	now = now.Add(59 * time.Second)
	get("aa")
	now = now.Add(time.Second)
	get("aa")
	if calls != 6 {
		t.Fatal("TTL was extended by a read, or expiration was ignored")
	}
	get("")
	if c.entries[labrastroTestBlobKey("")] == nil {
		t.Fatal("empty blob was not cached")
	}
}

func TestLabrastroBlobCacheEmptyEntryBound(t *testing.T) {
	c := newLabrastroBlobCache(labrastroBlobCacheBytes, labrastroBlobCacheTTL)
	key := labrastroTestBlobKey("")
	for i := 0; i < labrastroBlobCacheEntries+2; i++ {
		key.workspace = fmt.Sprint(i)
		if _, err := c.get(t.Context(), key, func() ([]byte, error) { return []byte{}, nil }); err != nil {
			t.Fatal(err)
		}
	}
	if c.bytes != 0 || len(c.entries) != labrastroBlobCacheEntries || c.entries[key] == nil {
		t.Fatal("empty blobs escaped the metadata bound")
	}
	key.workspace = "0"
	if c.entries[key] != nil {
		t.Fatal("entry limit did not evict the least recently used workspace blob")
	}
}

func TestLabrastroBlobCacheSingleflightAndCancellation(t *testing.T) {
	c := newLabrastroBlobCache(1024, time.Minute)
	key := labrastroTestBlobKey("body")
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	load := func() ([]byte, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return []byte("body"), nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Go(func() {
			body, err := c.get(t.Context(), key, load)
			if err != nil || string(body) != "body" {
				t.Errorf("shared result: %q %v", body, err)
			}
		})
	}
	<-started
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.get(ctx, key, load); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiter did not cancel: %v", err)
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 || len(c.flights) != 0 {
		t.Fatalf("duplicate or leaked flight: %d", calls.Load())
	}
	canceled, stop := context.WithCancel(t.Context())
	stop()
	if _, err := c.get(canceled, key, load); !errors.Is(err, context.Canceled) {
		t.Fatalf("cache hit ignored cancellation: %v", err)
	}
	key = labrastroTestBlobKey("canceled")
	ctx, cancel = context.WithCancel(t.Context())
	_, err := c.get(ctx, key, func() ([]byte, error) { cancel(); return []byte("canceled"), nil })
	if !errors.Is(err, context.Canceled) || c.entries[key] != nil || len(c.flights) != 0 {
		t.Fatal("canceled download entered cache or left a flight")
	}
}

func TestLabrastroSourceCachedSnapshotEquivalence(t *testing.T) {
	for _, name := range []string{"mattpocock", "addyosmani"} {
		t.Run(name, func(t *testing.T) {
			f := labrastroReadSourceFixture(t, name)
			f.delay = 20 * time.Millisecond
			cache := newLabrastroBlobCache(labrastroBlobCacheBytes, labrastroBlobCacheTTL)
			want, err := os.ReadFile(filepath.Join("testdata/labrastro-skill-packages", name+"-baseline.json"))
			if err != nil {
				t.Fatal(err)
			}
			for _, pass := range []string{"cold", "warm"} {
				start, before := time.Now(), f.requests
				src, err := newLabrastroSkillSource(t.Context(), f.client(), f.url(), t.Name())
				if err != nil {
					t.Fatal(err)
				}
				src.blobs = cache
				cs, ds, err := src.candidates(t.Context())
				if err != nil {
					t.Fatal(err)
				}
				actor := labrastroSkillActor{ws: parseUUID("11111111-1111-4111-8111-111111111111"), user: parseUUID("22222222-2222-4222-8222-222222222222")}
				got, err := json.MarshalIndent(map[string]any{"candidates": cs, "diagnostics": ds, "fingerprint": labrastroPreviewFingerprint(actor, labrastroPackageSnapshot{}, src, cs)}, "", "  ")
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(got, want) {
					t.Fatalf("%s outputs differ byte-for-byte from d8a51e11 baseline", pass)
				}
				raw := 0
				for _, p := range f.paths[before:] {
					if strings.HasPrefix(p, "/"+f.Owner+"/"+f.Repo+"/") {
						raw++
					}
				}
				if pass == "warm" && raw != 0 {
					t.Fatalf("warm scan downloaded %d raw blobs", raw)
				}
				if f.maxActive > treeDownloadConcurrency {
					t.Fatalf("download limit exceeded: %d", f.maxActive)
				}
				t.Logf("%s snapshot=%s requests=%d raw=%d peak_downloads=%d cache_bytes=%d elapsed=%s", pass, f.Commit, f.requests-before, raw, f.maxActive, cache.bytes, time.Since(start))
			}
		})
	}
}

func TestLabrastroParallelScopedCandidates(t *testing.T) {
	files := map[string]string{"references/shared.md": "shared"}
	for i := 0; i < 12; i++ {
		prefix := fmt.Sprintf("skills/%02d/", i)
		files[prefix+"SKILL.md"] = fmt.Sprintf("---\nname: skill-%02d\n---\n[shared](../../references/shared.md)", i)
		for j := 0; j < 8; j++ {
			files[prefix+fmt.Sprintf("%d.md", j)] = fmt.Sprintf("support %d/%d", i, j)
		}
	}
	f := labrastroTestFixture(files)
	f.delay = 2 * time.Millisecond
	src, err := newLabrastroSkillSource(t.Context(), f.client(), f.url()+"/tree/main/skills", t.Name())
	if err != nil {
		t.Fatal(err)
	}
	cs, _, err := src.candidates(t.Context())
	if err != nil || len(cs) != 12 {
		t.Fatalf("candidates: %d %v", len(cs), err)
	}
	for i, c := range cs {
		if c.Path != fmt.Sprintf("skills/%02d", i) || c.State != "new" || len(c.SharedFiles) != 1 {
			t.Fatalf("unstable/incomplete result: %+v", c)
		}
	}
	if f.maxActive > treeDownloadConcurrency || f.maxActive < 2 {
		t.Fatalf("unexpected parallelism: %d", f.maxActive)
	}
	shared := 0
	for _, p := range f.paths {
		if strings.Contains(p, "/references/shared.md?") {
			shared++
		}
	}
	if shared != 1 {
		t.Fatalf("shared blob downloaded %d times", shared)
	}
}

func TestLabrastroSourceHashMismatchNeverCached(t *testing.T) {
	f := labrastroTestFixture(map[string]string{"SKILL.md": "expected"})
	f.Files["SKILL.md"] = "tampered" // Keep the original tree identity.
	src, err := newLabrastroSkillSource(t.Context(), f.client(), f.url(), t.Name())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		cs, _, err := src.candidates(t.Context())
		if err != nil || len(cs) != 1 || cs[0].State != "failed" || cs[0].Diagnostics[0].Code != "source_unavailable" {
			t.Fatalf("hash mismatch not reported: %+v %v", cs, err)
		}
	}
	f.Files["SKILL.md"] = "expected"
	cs, _, err := src.candidates(t.Context())
	if err != nil || cs[0].State != "new" {
		t.Fatalf("failed hash poisoned retry: %+v %v", cs, err)
	}
}

func labrastroEvictWorkspaceBlobs(workspace string) {
	c := labrastroPackageBlobs
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, e := range c.entries {
		if key.workspace == workspace {
			c.remove(e)
		}
	}
}

func TestLabrastroCachedApplyStillConfirmsCommit(t *testing.T) {
	for _, change := range []bool{false, true} {
		t.Run(fmt.Sprint(change), func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			f := labrastroTestFixture(map[string]string{"skills/demo/SKILL.md": "demo"})
			f.install(t)
			preview := labrastroPreview(t, fx, testUserID, f.url())
			before := labrastroPackageSnapshotHash(t, fx)
			f.failPath = "skills/demo/SKILL.md"
			if change {
				f.Commit = strings.Repeat("a", 40)
			}
			status := http.StatusOK
			if change {
				status = http.StatusConflict
			}
			response := labrastroCall(t, fx, testUserID, testHandler.LabrastroApplyPackage, "POST", map[string]any{"url": f.url(), "preview_id": preview.PreviewID}).Want(status)
			if change {
				var failure struct {
					Code string `json:"code"`
				}
				response.JSON(&failure)
				if failure.Code != "preview_stale" || before != labrastroPackageSnapshotHash(t, fx) {
					t.Fatal("warm cache hid a ref change or wrote before validation")
				}
			} else {
				var result LabrastroPackageApplyResult
				response.JSON(&result)
				if result.Failed || len(result.Results) != 1 || result.Results[0].Status != "created" {
					t.Fatalf("warm apply failed: %+v", result)
				}
			}
		})
	}
}
