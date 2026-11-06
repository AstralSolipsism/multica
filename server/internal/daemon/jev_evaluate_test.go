package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
)

const taskEvaluation = `{"state":{"text":"evaluate me"},"questions":{"clarity":{"type":"score","instructions":"judge","criteria":["clear","unclear"]}}}`

func TestTaskEvaluationAuthorizationAndPayload(t *testing.T) {
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"answers":{"clarity":{"score":1}}}`)
	}))
	defer provider.Close()
	d := &Daemon{cfg: Config{CLIVersion: "test-build"}, jevClient: jev.New(jev.Options{Sources: []jev.Source{{Name: "local", BaseURL: provider.URL}}})}
	d.registerActiveRepoCheckoutTask("mat_test", activeRepoCheckoutTask{TaskID: "task-test"})
	for _, tc := range []struct {
		name, method, path, token, body string
		status                          int
	}{
		{"no credential", "POST", "task-test", "", taskEvaluation, 401},
		{"owner credential", "POST", "task-test", "owner-secret", taskEvaluation, 401},
		{"wrong task", "POST", "another", "mat_test", taskEvaluation, 403},
		{"method", "GET", "task-test", "mat_test", taskEvaluation, 405},
		{"override", "POST", "task-test", "mat_test", strings.Replace(taskEvaluation, `"state":`, `"sources":["evil"],"state":`, 1), 400},
		{"trailing", "POST", "task-test", "mat_test", taskEvaluation + `{}`, 400},
		{"oversize", "POST", "task-test", "mat_test", strings.Repeat(" ", jev.MaxEvaluationBytes) + taskEvaluation, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/tasks/"+tc.path+"/jev-evaluate", strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer "+tc.token)
			w := httptest.NewRecorder()
			d.taskEndpointsHandler().ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("%d: %s", w.Code, w.Body.String())
			}
		})
	}
	if calls != 0 {
		t.Fatal("unauthorized input reached provider")
	}
	r := httptest.NewRequest("POST", "/tasks/task-test/jev-evaluate", strings.NewReader(taskEvaluation))
	r.Header.Set("Authorization", "Bearer mat_test")
	w := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(w, r)
	var result jev.EvaluationResult
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || !result.OK || result.Answers["clarity"].Score != 1 || result.DaemonVersion != "test-build" || calls != 1 {
		t.Fatalf("%d %s calls=%d", w.Code, w.Body.String(), calls)
	}
	d.clearActiveRepoCheckoutTask("mat_test")
	r = httptest.NewRequest("POST", "/tasks/task-test/jev-evaluate", strings.NewReader(taskEvaluation))
	r.Header.Set("Authorization", "Bearer mat_test")
	w = httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(w, r)
	if w.Code != 401 || calls != 1 {
		t.Fatal("ended task still authorized")
	}
}

func TestTaskEvaluationUnavailableIsNotAScore(t *testing.T) {
	d := &Daemon{}
	d.registerActiveRepoCheckoutTask("mat_test", activeRepoCheckoutTask{TaskID: "task-test"})
	r := httptest.NewRequest("POST", "/tasks/task-test/jev-evaluate", strings.NewReader(taskEvaluation))
	r.Header.Set("Authorization", "Bearer mat_test")
	w := httptest.NewRecorder()
	d.taskEndpointsHandler().ServeHTTP(w, r)
	var result jev.EvaluationResult
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || result.OK || result.Reason != jev.ReasonDisabled || len(result.Answers) != 0 {
		t.Fatal(w.Body.String())
	}
}
