package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cli"
)

const pfProject = "11111111-1111-4111-8111-111111111111"
const pfWorkspace = "22222222-2222-4222-8222-222222222222"
const pfFile = "33333333-3333-4333-8333-333333333333"
const pfVersion = "44444444-4444-4444-8444-444444444444"
const pfCandidate = "55555555-5555-4555-8555-555555555555"

// This controlled HTTP peer implements the frozen OL-33 wire contract only.
// It is intentionally independent of the backend implementation and database.
type projectFilePeer struct {
	t         *testing.T
	mu        sync.Mutex
	revision  int64
	versions  map[int64][]byte
	candidate []byte
	resolved  bool
	bindings  map[string]string
	results   map[string]map[string]any
	calls     int
	dropNext  bool
}

func newProjectFilePeer(t *testing.T) *projectFilePeer {
	return &projectFilePeer{t: t, versions: map[int64][]byte{}, bindings: map[string]string{}, results: map[string]map[string]any{}}
}

func (p *projectFilePeer) state() (int, int64, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls, p.revision, string(p.versions[1])
}

func (p *projectFilePeer) callCount() int { calls, _, _ := p.state(); return calls }

func (p *projectFilePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	actor := r.Header.Get("Authorization")
	if (actor != "Bearer mat_file_test" && actor != "Bearer mat_file_test_a" && actor != "Bearer mat_file_test_b") || r.Header.Get("X-Workspace-ID") != pfWorkspace {
		p.t.Error("request did not use the configured business identity/workspace")
		w.WriteHeader(403)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/projects/"+pfProject+"/files")
	w.Header().Set("Content-Type", "application/json")
	write := func(code int, data any) {
		w.WriteHeader(code)
		if err := json.NewEncoder(w).Encode(data); err != nil {
			p.t.Error(err)
		}
	}
	if r.Method == "GET" {
		switch {
		case path == "/capabilities":
			write(200, map[string]any{"enabled": true, "api_version": 1, "read_only": false, "max_file_bytes": 67108864, "max_page_size": 200})
		case strings.HasPrefix(path, "/operations/"):
			key := strings.TrimPrefix(path, "/operations/")
			result := p.results[actor+"|"+key]
			if result == nil {
				write(404, map[string]any{"code": "NOT_FOUND", "error": "operation not found"})
				return
			}
			result["replayed"] = true
			write(200, map[string]any{"state": "COMPLETED", "operation_id": key, "result": result})
		case path == "/content" || path == "/candidates/"+pfCandidate+"/content":
			rev := p.revision
			if r.URL.Query().Has("revision") {
				rev, _ = strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
			}
			data := p.versions[rev]
			base := rev - 1
			if strings.HasPrefix(path, "/candidates/") {
				rev, base, data = 0, 1, p.candidate
				w.Header().Set("X-Candidate-ID", pfCandidate)
			}
			w.Header().Set("X-File-ID", pfFile)
			w.Header().Set("X-Version-ID", pfVersion)
			w.Header().Set("X-Revision", strconv.FormatInt(rev, 10))
			w.Header().Set("X-Base-Revision", strconv.FormatInt(base, 10))
			w.Header().Set("X-Content-SHA256", fmt.Sprintf("%x", sha256.Sum256(data)))
			w.Header().Set("Content-Length", strconv.Itoa(len(data)))
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write(data)
		case path == "" || path == "/candidates":
			files := []any{}
			if path == "/candidates" && p.candidate != nil && !p.resolved {
				files = append(files, map[string]any{"file_id": pfFile, "path": "notes.md", "revision": 0, "base_revision": 1, "version_id": pfVersion, "candidate_id": pfCandidate, "size_bytes": len(p.candidate), "sha256": fmt.Sprintf("%x", sha256.Sum256(p.candidate)), "content_type": "text/plain", "author_type": "agent", "author_id": pfFile, "updated_at": "2026-09-08T00:00:00Z"})
			}
			write(200, map[string]any{"files": files})
		default:
			p.t.Errorf("unexpected GET %s", r.URL)
			w.WriteHeader(404)
		}
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		p.t.Error(err)
		w.WriteHeader(400)
		return
	}
	if r.ContentLength != int64(len(body)) || len(r.TransferEncoding) != 0 {
		p.t.Errorf("unknown/incorrect upload length: %d vs %d", r.ContentLength, len(body))
	}
	key := r.Header.Get("Idempotency-Key")
	scopedKey := actor + "|" + key
	binding := r.Method + "|" + r.URL.RequestURI() + "|" + r.Header.Get("X-Base-Revision") + "|" + r.Header.Get("Content-Type") + "|" + r.Header.Get("X-Content-SHA256") + "|" + string(body)
	if before, ok := p.bindings[scopedKey]; ok {
		if before != binding {
			write(409, map[string]any{"code": "OPERATION_KEY_REUSED", "error": "operation key is bound to a different request"})
			return
		}
		result := p.results[scopedKey]
		result["replayed"] = true
		status := 200
		if result["status"] == "CONFLICT" {
			status = 409
		}
		write(status, result)
		return
	}
	base, _ := strconv.ParseInt(r.Header.Get("X-Base-Revision"), 10, 64)
	logicalPath := r.URL.Query().Get("path")
	if r.Method == "POST" {
		var adopt struct {
			Path             string `json:"path"`
			ExpectedRevision int64  `json:"expected_revision"`
		}
		if json.Unmarshal(body, &adopt) != nil {
			p.t.Error("invalid adoption body")
		}
		base, logicalPath, body = adopt.ExpectedRevision, adopt.Path, p.candidate
	} else if r.Header.Get("X-Content-SHA256") != fmt.Sprintf("%x", sha256.Sum256(body)) {
		p.t.Error("upload digest does not cover actual bytes")
	}
	result := map[string]any{"operation_id": key, "status": "SAVED", "file_id": pfFile, "path": logicalPath, "base_revision": base, "version_id": pfVersion, "replayed": false}
	status := 200
	if base != p.revision {
		status = 409
		result["status"], result["candidate_id"], result["conflict_current"] = "CONFLICT", pfCandidate, p.revision
		if r.Method == "PUT" {
			p.candidate = append([]byte{}, body...)
		}
	} else {
		p.revision++
		p.versions[p.revision] = append([]byte{}, body...)
		if r.Method == "POST" {
			p.resolved = true
		}
	}
	result["revision"] = p.revision
	p.bindings[scopedKey], p.results[scopedKey] = binding, result
	if p.dropNext {
		p.dropNext = false
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			p.t.Error(err)
			return
		}
		_ = conn.Close()
		return
	}
	write(status, result)
}

func projectFileTestEnv(t *testing.T, serverURL string) {
	t.Helper()
	t.Setenv("MULTICA_SERVER_URL", serverURL)
	t.Setenv("MULTICA_WORKSPACE_ID", pfWorkspace)
	t.Setenv("MULTICA_TOKEN", "mat_file_test")
	t.Setenv("MULTICA_TASK_ID", pfFile)
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", t.TempDir())
}

func runFileCLI(t *testing.T, wantExit int, args ...string) map[string]any {
	t.Helper()
	cmd := newProjectFileCmd()
	var out, stderr bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&stderr)
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetArgs(args)
	err := cmd.Execute()
	if got := cli.ExitCodeFor(err); got != wantExit {
		t.Fatalf("%v: exit %d, want %d; err=%v stdout=%s stderr=%s", args, got, wantExit, err, out.String(), stderr.String())
	}
	var result map[string]any
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatalf("stdout is not one structured response: %q: %v", out.String(), err)
	}
	return result
}

func writeFileTest(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertReplayFields(t *testing.T, first, replay map[string]any) {
	t.Helper()
	if replay["replayed"] != true {
		t.Fatalf("not marked replayed: %v", replay)
	}
	first["replayed"], replay["replayed"] = true, true
	if !reflect.DeepEqual(first, replay) {
		t.Fatalf("complete replay differs: first=%v replay=%v", first, replay)
	}
}

func TestProjectFileCLIRevisionConflictAdoptionAndReplay(t *testing.T) {
	peer := newProjectFilePeer(t)
	server := httptest.NewServer(peer)
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	dir := t.TempDir()
	source := filepath.Join(dir, "draft")
	request := func(name string) string { return filepath.Join(dir, name+".json") }
	save := func(key, body string, base int64, want int) map[string]any {
		writeFileTest(t, source, body)
		return runFileCLI(t, want, "save", pfProject, "notes.md", "--base-revision", strconv.FormatInt(base, 10), "--from-file", source, "--content-type", "text/plain", "--operation-id", key, "--request-file", request(key))
	}
	if caps := runFileCLI(t, 0, "capabilities", pfProject); caps["api_version"] != float64(1) {
		t.Fatal(caps)
	}
	first := save("first", "original", 0, 0)
	assertReplayFields(t, first, runFileCLI(t, 0, "retry", request("first")))
	download := filepath.Join(dir, "read")
	meta := runFileCLI(t, 0, "read", pfProject, "notes.md", "--to-file", download)
	if meta["revision"] != float64(1) || meta["base_revision"] != float64(0) {
		t.Fatalf("working base must come from revision: %v", meta)
	}
	content, _ := os.ReadFile(download)
	if string(content) != "original" {
		t.Fatal(string(content))
	}
	save("winner", "winning edit", 1, 0)
	conflict := save("stale", "preserved losing edit", 1, cli.ExitFileConflict)
	if conflict["revision"] != float64(2) || conflict["candidate_id"] != pfCandidate {
		t.Fatal(conflict)
	}
	assertReplayFields(t, conflict, runFileCLI(t, 6, "retry", request("stale")))
	// The same key cannot be repurposed, even across save/adopt.
	writeFileTest(t, source, "different payload")
	reused := runFileCLI(t, 1, "save", pfProject, "notes.md", "--base-revision", "1", "--from-file", source, "--operation-id", "stale", "--request-file", request("reused"))
	if reused["code"] != "OPERATION_KEY_REUSED" || reused["candidate_id"] != nil {
		t.Fatal(reused)
	}
	runFileCLI(t, 1, "adopt", pfProject, "notes.md", pfCandidate, "--expected-revision", "2", "--operation-id", "stale", "--request-file", request("cross-kind"))
	page := runFileCLI(t, 0, "candidates", pfProject, "notes.md")
	if len(page["files"].([]any)) != 1 {
		t.Fatal(page)
	}
	candidateCopy := filepath.Join(dir, "candidate")
	meta = runFileCLI(t, 0, "candidate", pfProject, pfCandidate, "--to-file", candidateCopy)
	if meta["revision"] != float64(0) || meta["candidate_id"] != pfCandidate {
		t.Fatal(meta)
	}
	runFileCLI(t, 6, "adopt", pfProject, "notes.md", pfCandidate, "--expected-revision", "1", "--request-file", request("stale-adopt"))
	adopt := runFileCLI(t, 0, "adopt", pfProject, "notes.md", pfCandidate, "--expected-revision", "2", "--operation-id", "adopt", "--request-file", request("adopt"))
	if adopt["revision"] != float64(3) || adopt["candidate_id"] != nil || adopt["conflict_current"] != nil {
		t.Fatal(adopt)
	}
	assertReplayFields(t, adopt, runFileCLI(t, 0, "retry", request("adopt")))
	op := runFileCLI(t, 0, "operation", pfProject, "adopt")
	assertReplayFields(t, adopt, op["result"].(map[string]any))
	// Original conflict stays a conflict after adoption and head advancement.
	assertReplayFields(t, conflict, runFileCLI(t, 6, "retry", request("stale")))
	runFileCLI(t, 0, "candidate", pfProject, pfCandidate, "--to-file", filepath.Join(dir, "resolved-candidate"))
	history := filepath.Join(dir, "historical")
	runFileCLI(t, 0, "read", pfProject, "notes.md", "--revision", "1", "--to-file", history)
	content, _ = os.ReadFile(history)
	if string(content) != "original" {
		t.Fatal("historical read used current content")
	}
	page = runFileCLI(t, 0, "candidates", pfProject, "notes.md")
	if len(page["files"].([]any)) != 0 {
		t.Fatal("resolved candidate still listed")
	}
	if _, revision, _ := peer.state(); revision != 3 {
		t.Fatalf("retries introduced revisions: %d", revision)
	}
}

func TestProjectFileCLILostAcknowledgementPreservesOriginalRequest(t *testing.T) {
	peer := newProjectFilePeer(t)
	peer.dropNext = true
	server := httptest.NewServer(peer)
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	dir := t.TempDir()
	source, snapshot := filepath.Join(dir, "draft"), filepath.Join(dir, "request.json")
	writeFileTest(t, source, "bytes before connection loss")
	out := runFileCLI(t, 2, "save", pfProject, "notes.md", "--base-revision", "0", "--from-file", source, "--request-file", snapshot)
	if out["state"] != "UNCONFIRMED" || out["operation_id"] == "" || peer.callCount() != 1 {
		t.Fatal(out, peer.callCount())
	}
	writeFileTest(t, source, "new editing must not alter a retry")
	raw, _ := os.ReadFile(snapshot)
	if bytes.Contains(raw, []byte("mat_file_test")) {
		t.Fatal("snapshot leaked credential")
	}
	info, _ := os.Stat(snapshot)
	if info.Mode().Perm()&0077 != 0 {
		t.Fatalf("snapshot is not private: %v", info.Mode())
	}
	op := runFileCLI(t, 0, "operation", pfProject, out["operation_id"].(string))
	if op["state"] != "COMPLETED" {
		t.Fatal(op)
	}
	runFileCLI(t, 0, "retry", snapshot)
	if _, revision, original := peer.state(); revision != 1 || original != "bytes before connection loss" {
		t.Fatal("lost-ack retry modified content or committed twice")
	}
	// A later task cannot replay an old task's private operation as itself.
	t.Setenv("MULTICA_TOKEN", "mat_another_run")
	before := peer.callCount()
	runFileCLI(t, 5, "retry", snapshot)
	if peer.callCount() != before {
		t.Fatal("cross-credential retry reached network")
	}
}

func TestProjectFileCLIHTTPFailuresKeepSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name         string
		status, exit int
		code         string
	}{
		{"unauthorized", 401, 3, ""}, {"denied", 403, 3, "ACCESS_DENIED"}, {"read-only", 403, 3, "READ_ONLY"},
		{"parameters", 400, 5, "INVALID_REQUEST"}, {"content", 400, 5, "CONTENT_MISMATCH"}, {"size", 413, 1, "FILE_TOO_LARGE"},
		{"collision", 409, 1, "PATH_COLLISION"}, {"disabled", 503, 7, "PROJECT_FILES_DISABLED"},
		{"storage", 503, 7, "STORAGE_UNAVAILABLE"}, {"unknown", 503, 7, "OUTCOME_UNKNOWN"}, {"timeout", 503, 7, "TEMPORARILY_UNAVAILABLE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": tc.code, "error": tc.name})
			}))
			defer server.Close()
			projectFileTestEnv(t, server.URL)
			dir := t.TempDir()
			source, snapshot := filepath.Join(dir, "draft"), filepath.Join(dir, "request.json")
			writeFileTest(t, source, "keep this draft")
			out := runFileCLI(t, tc.exit, "save", pfProject, "notes.md", "--base-revision", "0", "--from-file", source, "--request-file", snapshot)
			if calls != 1 || out["status"] != nil || out["candidate_id"] != nil {
				t.Fatal("failure became a confirmed write", out, calls)
			}
			saved, err := readProjectFileSnapshot(snapshot)
			if err != nil || string(saved.Request.Data) != "keep this draft" || saved.Request.BaseRevision != 0 {
				t.Fatal(saved, err)
			}
			if tc.code != "" && out["code"] != tc.code {
				t.Fatalf("wire error code lost: %v", out)
			}
		})
	}
}

func TestProjectFileCLIUntrustedResponsesNeverConfirm(t *testing.T) {
	valid := func() map[string]any {
		return map[string]any{"operation_id": "op", "status": "SAVED", "file_id": pfFile, "path": "notes.md", "base_revision": 0, "revision": 1, "version_id": pfVersion, "replayed": false}
	}
	for _, tc := range []struct {
		name   string
		edit   func(map[string]any)
		status int
	}{
		{"future", func(r map[string]any) { r["status"] = "QUEUED" }, 200},
		{"missing-revision", func(r map[string]any) { delete(r, "revision") }, 200},
		{"missing-replayed", func(r map[string]any) { delete(r, "replayed") }, 200},
		{"wrong-key", func(r map[string]any) { r["operation_id"] = "other" }, 200},
		{"wrong-path", func(r map[string]any) { r["path"] = "other.md" }, 200},
		{"wrong-base", func(r map[string]any) { r["base_revision"], r["revision"] = 1, 2 }, 200},
		{"saved-candidate", func(r map[string]any) { r["candidate_id"] = pfCandidate }, 200},
		{"saved-null-candidate", func(r map[string]any) { r["candidate_id"] = nil }, 200},
		{"conflict-incomplete", func(r map[string]any) { r["status"] = "CONFLICT" }, 409},
		{"wrong-http-status", func(r map[string]any) {}, 409},
		{"pending-http-status", func(r map[string]any) {}, 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				result := valid()
				tc.edit(result)
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer server.Close()
			projectFileTestEnv(t, server.URL)
			dir := t.TempDir()
			source := filepath.Join(dir, "draft")
			writeFileTest(t, source, "data")
			out := runFileCLI(t, 7, "save", pfProject, "notes.md", "--base-revision", "0", "--from-file", source, "--operation-id", "op", "--request-file", filepath.Join(dir, "request.json"))
			if out["status"] != nil || out["state"] != "UNCONFIRMED" {
				t.Fatal(out)
			}
		})
	}
}

func TestProjectFileCLIEmptySaveAndRequestIntegrity(t *testing.T) {
	peer := newProjectFilePeer(t)
	server := httptest.NewServer(peer)
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	dir := t.TempDir()
	source, snapshot := filepath.Join(dir, "empty"), filepath.Join(dir, "request.json")
	writeFileTest(t, source, "")
	runFileCLI(t, 0, "save", pfProject, "empty", "--base-revision", "0", "--from-file", source, "--request-file", snapshot)
	before := peer.callCount()
	runFileCLI(t, 1, "save", pfProject, "empty", "--base-revision", "0", "--from-file", source, "--request-file", snapshot)
	if peer.callCount() != before {
		t.Fatal("existing snapshot was overwritten or resent")
	}
	saved, _ := readProjectFileSnapshot(snapshot)
	saved.Request.Data = []byte("tampered")
	raw, _ := json.Marshal(saved)
	writeFileTest(t, snapshot, string(raw))
	runFileCLI(t, 5, "retry", snapshot)
	if peer.callCount() != before {
		t.Fatal("tampered snapshot reached API")
	}
}

func TestProjectFileCLIInputValidation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid input reached API") }))
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	dir := t.TempDir()
	source := filepath.Join(dir, "draft")
	writeFileTest(t, source, "draft")
	for _, args := range [][]string{
		{"capabilities", "not-uuid"}, {"list", pfProject, "--limit", "0"}, {"list", pfProject, "--limit", "201"},
		{"operation", pfProject, "bad/key"}, {"candidate", pfProject, "bad", "--to-file", filepath.Join(dir, "new")},
		{"save", pfProject, "notes.md", "--from-file", source, "--request-file", filepath.Join(dir, "new")},
		{"adopt", pfProject, "notes.md", pfCandidate, "--request-file", filepath.Join(dir, "new")},
		{"save", pfProject, "../bad", "--base-revision", "0", "--from-file", source, "--request-file", filepath.Join(dir, "new")},
		{"save", pfProject, "notes.md", "--base-revision", "-1", "--from-file", source, "--request-file", filepath.Join(dir, "new")},
		{"read", pfProject, "notes.md", "--revision", "0", "--to-file", filepath.Join(dir, "new")},
		{"read", pfProject, "notes.md", "--to-file", source}, {"list", pfProject, "--output", "table"},
		{"read", pfProject},
	} {
		runFileCLI(t, 5, args...)
	}
}

func TestProjectFileCLIPendingAndLookupAbsence(t *testing.T) {
	for _, tc := range []struct {
		code int
		body string
		exit int
	}{
		{202, `{"state":"PENDING","operation_id":"op"}`, 7},
		{404, `{"code":"NOT_FOUND","error":"no operation"}`, 4},
		{200, `{"state":"COMPLETED","operation_id":"op"}`, 7},
		{200, `{"state":"PENDING","operation_id":"op"}`, 7},
		{202, `{"state":"PENDING","operation_id":"other"}`, 7},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.code)
			_, _ = io.WriteString(w, tc.body)
		}))
		projectFileTestEnv(t, server.URL)
		runFileCLI(t, tc.exit, "operation", pfProject, "op")
		server.Close()
	}
}

func TestProjectFileCLIBoundedDiscoveryAndEscaping(t *testing.T) {
	path := "资料/%_ & +?#.md"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("prefix") != path || q.Get("after") != path || q.Get("limit") != "2" {
			t.Error(r.URL.String())
		}
		_, _ = io.WriteString(w, `{"files":[],"next_cursor":"next"}`)
	}))
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	out := runFileCLI(t, 0, "list", pfProject, "--prefix", path, "--after", path, "--limit", "2")
	if out["next_cursor"] != "next" {
		t.Fatal("cursor dropped")
	}
}

func TestProjectFileCLIDownloadIntegrityAndRedirect(t *testing.T) {
	for _, kind := range []string{"hash", "truncated", "revision", "redirect", "oversize"} {
		t.Run(kind, func(t *testing.T) {
			redirected := 0
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected++ }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if kind == "redirect" {
					http.Redirect(w, r, target.URL, 307)
					return
				}
				w.Header().Set("Content-Length", "4")
				w.Header().Set("X-Revision", "1")
				w.Header().Set("X-Base-Revision", "0")
				w.Header().Set("X-File-ID", pfFile)
				w.Header().Set("X-Version-ID", uuid.NewString())
				w.Header().Set("X-Content-SHA256", fmt.Sprintf("%x", sha256.Sum256([]byte("data"))))
				switch kind {
				case "revision":
					w.Header().Set("X-Revision", "3")
				case "oversize":
					w.Header().Set("Content-Length", "67108865")
				case "hash":
					_, _ = io.WriteString(w, "oops")
					return
				case "truncated":
					_, _ = io.WriteString(w, "d")
					return
				}
				_, _ = io.WriteString(w, "data")
			}))
			defer server.Close()
			projectFileTestEnv(t, server.URL)
			dest := filepath.Join(t.TempDir(), "download")
			exit := 7
			if kind == "truncated" {
				exit = 2
			}
			if kind == "redirect" {
				exit = 1
			}
			runFileCLI(t, exit, "read", pfProject, "notes.md", "--revision", "1", "--to-file", dest)
			if _, err := os.Lstat(dest); !os.IsNotExist(err) {
				t.Fatal("bad download published", err)
			}
			if redirected != 0 {
				t.Fatal("followed redirect with business credential")
			}
		})
	}
}

// Verify the handoff script and real process exit statuses against two isolated
// synthetic run identities. This does not launch an installed agent/runtime.
func TestProjectFileRuntimeCheckScript(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python 3 is required for the optional handoff script check")
	}
	_, source, _, _ := runtime.Caller(0)
	packageDir := filepath.Dir(source)
	script := filepath.Join(packageDir, "../../scripts/project-files-runtime-check.py")
	bin := filepath.Join(t.TempDir(), "multica")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", bin, ".")
	build.Dir = packageDir
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	peer := newProjectFilePeer(t)
	server := httptest.NewServer(peer)
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	aDir, bDir := t.TempDir(), t.TempDir()
	for _, phase := range []string{"a-seed", "b-read", "a-advance", "b-conflict", "b-adopt", "a-verify"} {
		actor, dir := "a", aDir
		if strings.HasPrefix(phase, "b-") {
			actor, dir = "b", bDir
		}
		cmd := exec.Command(python, script, phase, "--project", pfProject, "--case", "ol37/script-test")
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "MULTICA_BIN="+bin, "MULTICA_TOKEN=mat_file_test_"+actor, "MULTICA_TASK_ID=run-"+actor)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", phase, err, output)
		}
		var report struct {
			Passed bool `json:"passed"`
		}
		if json.Unmarshal(output, &report) != nil || !report.Passed {
			t.Fatalf("%s did not pass: %s", phase, output)
		}
	}
}

func TestProjectFileCLIConcurrentSnapshotPublication(t *testing.T) {
	peer := newProjectFilePeer(t)
	server := httptest.NewServer(peer)
	defer server.Close()
	projectFileTestEnv(t, server.URL)
	dir := t.TempDir()
	source, snapshot := filepath.Join(dir, "draft"), filepath.Join(dir, "same-request.json")
	writeFileTest(t, source, "one immutable request")
	start := make(chan struct{})
	exits := make(chan int, 2)
	for i := range 2 {
		go func() {
			cmd := newProjectFileCmd()
			cmd.SilenceUsage, cmd.SilenceErrors = true, true
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			cmd.SetArgs([]string{"save", pfProject, "notes.md", "--base-revision", "0", "--from-file", source, "--request-file", snapshot, "--operation-id", fmt.Sprintf("concurrent-%d", i)})
			<-start
			exits <- cli.ExitCodeFor(cmd.Execute())
		}()
	}
	close(start)
	first, second := <-exits, <-exits
	if !((first == 0 && second == 1) || (first == 1 && second == 0)) {
		t.Fatalf("publication did not choose exactly one writer: %d, %d", first, second)
	}
	if peer.callCount() != 1 {
		t.Fatal("unpreserved losing request reached API")
	}
	if _, err := readProjectFileSnapshot(snapshot); err != nil {
		t.Fatal("winner's snapshot was damaged", err)
	}
}
