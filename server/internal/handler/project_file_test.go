package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/projectfile"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type projectFileObjects struct{ content map[string][]byte }

func (s *projectFileObjects) Put(_ context.Context, key string, body io.Reader, _ int64, _ string) error {
	data, err := io.ReadAll(body)
	if err == nil {
		s.content[key] = data
	}
	return err
}
func (s *projectFileObjects) Open(_ context.Context, key string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(s.content[key])), nil
}

func projectFileTestAPI(t *testing.T) (*Handler, http.Handler, string, string) {
	t.Helper()
	h := *testHandler
	h.ProjectFiles = projectfile.New(h.Queries, testPool, &projectFileObjects{content: map[string][]byte{}}, projectfile.Options{MaxBytes: 100})
	project := dbfx.Project(t, "HTTP shared files")
	for _, table := range []string{"project_file", "project_file_version", "project_file_candidate", "project_file_operation", "project_file_upload"} {
		dbfx.Cleanup(t, "DELETE FROM "+table+" WHERE project_id=$1", project)
	}
	router := chi.NewRouter()
	router.Use(middleware.Auth(h.Queries, nil, nil))
	router.Use(middleware.RequireWorkspaceMember(h.Queries))
	router.Route("/api/projects/{id}/files", func(r chi.Router) {
		r.Get("/capabilities", h.ProjectFileCapabilities)
		r.Get("/", h.ListProjectFiles)
		r.Get("/content", h.ReadProjectFile)
		r.Put("/content", h.SaveProjectFile)
		r.Get("/candidates", h.ListProjectFileCandidates)
		r.Get("/candidates/{candidateId}/content", h.ReadProjectFileCandidate)
		r.Post("/candidates/{candidateId}/adopt", h.AdoptProjectFileCandidate)
		r.Get("/operations/{operationId}", h.GetProjectFileOperation)
	})
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": testUserID, "exp": time.Now().Add(time.Hour).Unix()}).SignedString(auth.JWTSecret())
	if err != nil {
		t.Fatal(err)
	}
	return &h, router, project, token
}

func projectFileHTTP(method, url, token string, body any) *http.Request {
	return testutil.WithHeaders(testutil.JSONRequest(method, url, body), "Authorization", "Bearer "+token, "X-Workspace-ID", testWorkspaceID)
}

func TestProjectFileHTTPContractAndTrustedIdentity(t *testing.T) {
	h, router, project, token := projectFileTestAPI(t)
	base := "/api/projects/" + project + "/files"
	var capability map[string]any
	testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", base+"/capabilities", token, nil)).Want(200).JSON(&capability)
	if capability["max_file_bytes"] != float64(100) {
		t.Fatalf("capability: %v", capability)
	}
	req := projectFileHTTP("PUT", base+"/content?path=facts.md", token, []byte("hello"))
	testutil.WithHeaders(req, "Idempotency-Key", "save-1", "X-Base-Revision", "0", "X-Content-SHA256", fmt.Sprintf("%x", sha256.Sum256([]byte("hello"))), "Content-Type", "text/plain",
		"X-Agent-ID", uuid.NewString(), "X-Task-ID", uuid.NewString(), "X-Actor-Source", "task_token")
	var result projectfile.Result
	testutil.Call(t, router.ServeHTTP, req).Want(200).JSON(&result)
	if result.Status != projectfile.StatusSaved || result.CandidateID != "" {
		t.Fatalf("result=%+v", result)
	}
	response := testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", base+"/content?path=facts.md", token, nil)).Want(200)
	if response.Body.String() != "hello" || response.Header().Get("X-Revision") != "1" || response.Header().Get("X-Version-ID") != result.VersionID {
		t.Fatalf("read headers=%v bytes=%q", response.Header(), response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-store" || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("unsafe download policy")
	}
	var page projectfile.Page
	testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", base+"/", token, nil)).Want(200).JSON(&page)
	if len(page.Files) != 1 || page.Files[0].AuthorType != "member" || page.Files[0].AuthorID != testUserID || page.Files[0].SourceTaskID != "" {
		t.Fatalf("client spoofed author: %+v", page)
	}
	unauthenticated := testutil.WithURLParams(testutil.JSONRequest("GET", base+"/", nil), "id", project)
	testutil.WithHeaders(unauthenticated, "X-User-ID", testUserID, "X-Workspace-ID", testWorkspaceID)
	testutil.Call(t, h.ListProjectFiles, unauthenticated).Want(403)
	testutil.Call(t, router.ServeHTTP, testutil.JSONRequest("GET", base+"/content?path=facts.md", nil)).Want(401)
}

func TestProjectFileHTTPRejectsMalformedInputs(t *testing.T) {
	_, router, project, token := projectFileTestAPI(t)
	base := "/api/projects/" + project + "/files"
	for _, body := range []any{
		map[string]any{"path": "facts.md"},
		map[string]any{"path": "facts.md", "expected_revision": "1"},
		map[string]any{"path": "facts.md", "expected_revision": 1, "author_id": testUserID},
		`{"path":"facts.md","expected_revision":1} {}`,
	} {
		req := projectFileHTTP("POST", base+"/candidates/"+uuid.NewString()+"/adopt", token, body)
		req.Header.Set("Idempotency-Key", "bad")
		testutil.Call(t, router.ServeHTTP, req).Want(400)
	}
	for _, query := range []string{"?limit=201", "?limit=-1", "?prefix=../", "?after=/bad"} {
		testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", base+"/"+query, token, nil)).Want(400)
	}
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("X-Base-Revision") },
		func(r *http.Request) { r.Header.Set("X-Content-SHA256", "bad") },
		func(r *http.Request) { r.ContentLength = -1 },
	} {
		req := projectFileHTTP("PUT", base+"/content?path=facts.md", token, []byte("hello"))
		testutil.WithHeaders(req, "Idempotency-Key", "bad", "X-Base-Revision", "0", "X-Content-SHA256", fmt.Sprintf("%x", sha256.Sum256([]byte("hello"))))
		change(req)
		testutil.Call(t, router.ServeHTTP, req).Want(400)
	}
	req := projectFileHTTP("PUT", base+"/content?path=large", token, []byte(strings.Repeat("x", 101)))
	testutil.WithHeaders(req, "Idempotency-Key", "large", "X-Base-Revision", "0", "X-Content-SHA256", fmt.Sprintf("%x", sha256.Sum256([]byte(strings.Repeat("x", 101)))))
	testutil.Call(t, router.ServeHTTP, req).Want(413)
}

func TestProjectFileHTTPTaskTokenProjectBinding(t *testing.T) {
	_, router, project, _ := projectFileTestAPI(t)
	base := "/api/projects/" + project + "/files"
	runtimeID := dbfx.Runtime(t, "Project file runtime")
	agentID := dbfx.Agent(t, "Project file agent "+uuid.NewString(), runtimeID)
	issueID := dbfx.Issue(t, "Project-bound run", testutil.Cols{"project_id": project})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID, "status": "running"})
	token := "mat_" + uuid.NewString()
	dbfx.Insert(t, "task_token", testutil.Cols{"token_hash": auth.HashToken(token), "user_id": testUserID, "task_id": taskID, "agent_id": agentID, "workspace_id": testWorkspaceID, "expires_at": time.Now().Add(time.Hour)})
	testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", base+"/", token, nil)).Want(200)
	other := dbfx.Project(t, "Other project")
	testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", "/api/projects/"+other+"/files/", token, nil)).Want(403)
	dbfx.Exec(t, "UPDATE issue SET project_id=NULL WHERE id=$1", issueID)
	testutil.Call(t, router.ServeHTTP, projectFileHTTP("GET", base+"/", token, nil)).Want(403)
}
