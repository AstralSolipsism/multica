package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	dependencyCLIActor = "11111111-1111-4111-8111-111111111111"
	dependencyCLIA     = "22222222-2222-4222-8222-222222222222"
	dependencyCLIB     = "33333333-3333-4333-8333-333333333333"
	dependencyCLIC     = "44444444-4444-4444-8444-444444444444"
	dependencyCLIChild = "55555555-5555-4555-8555-555555555555"
)

// Exercise main, Cobra parsing, HTTP, stdout/stderr and real process exits.
// The subprocess has only synthetic credentials and cannot read an owner profile.
func TestDependencyCLIProcess(t *testing.T) {
	if os.Getenv("MULTICA_DEPENDENCY_CLI_TEST") != "1" {
		return
	}
	// The package TestMain clears ambient Multica settings before tests run.
	t.Setenv("MULTICA_SERVER_URL", os.Getenv("MULTICA_DEPENDENCY_CLI_TEST_URL"))
	t.Setenv("MULTICA_TOKEN", "mat_dependency_test")
	t.Setenv("MULTICA_WORKSPACE_ID", dependencyCLIActor)
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", t.TempDir())
	t.Setenv("MULTICA_AGENT_ID", dependencyCLIActor)
	t.Setenv("MULTICA_TASK_ID", dependencyCLIChild)
	rootCmd.SetArgs(os.Args[3:])
	main()
	os.Exit(0)
}

func callDependencyCLI(t *testing.T, server string, wantExit int, args ...string) (string, string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestDependencyCLIProcess$", "--"}, args...)...)
	cmd.Dir = t.TempDir()
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"), "MULTICA_DEPENDENCY_CLI_TEST=1",
		"MULTICA_DEPENDENCY_CLI_TEST_URL=" + server,
	}
	if err := os.WriteFile(cmd.Dir+"/comment.md", []byte("ordinary comment"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	err := cmd.Run()
	exit := 0
	if err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			exit = e.ExitCode()
		} else {
			t.Fatal(err)
		}
	}
	if exit != wantExit {
		t.Fatalf("%v: exit=%d want=%d\nstdout=%s\nstderr=%s", args, exit, wantExit, out.String(), stderr.String())
	}
	return out.String(), stderr.String()
}

func dependencyCLIView() map[string]any {
	entry := func(id string, satisfied bool) map[string]any {
		return map[string]any{"issue_id": id, "identifier": "DEP-1", "status": "todo", "satisfied": satisfied, "source_edges": []string{dependencyCLIChild}, "inherited_from": []string{}, "title": "prerequisite"}
	}
	return map[string]any{
		"blocked_by": []any{entry(dependencyCLIA, false)}, "inherited_blocked_by": []any{entry(dependencyCLIC, false)},
		"blocking": []any{}, "unsatisfied": []any{entry(dependencyCLIA, false), entry(dependencyCLIC, false)},
		"has_restricted_blockers": false, "dependency_version": "opaque-v1", "future_field": "preserved",
	}
}

func TestDependencyCLICompoundWrites(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		args               []string
		fields             map[string]any
		reads              int
	}{
		{"create", "POST", "/api/issues/with-dependencies", []string{"create", "--title", "Checkout", "--parent", dependencyCLIChild, "--project", dependencyCLIActor, "--stage", "3", "--blocked-by", "DEP-1", "--blocked-by", dependencyCLIC, "--blocked-by", dependencyCLIA, "--status", "backlog"}, map[string]any{"blocked_by": []any{dependencyCLIA, dependencyCLIC}, "parent_issue_id": dependencyCLIChild, "project_id": dependencyCLIActor, "stage": float64(3), "status": "backlog"}, 0},
		{"replace", "PATCH", "/api/issues/" + dependencyCLIB + "/with-dependencies", []string{"update", dependencyCLIB, "--blocked-by", dependencyCLIA, "--blocked-by", dependencyCLIC, "--title", "atomic", "--no-start"}, map[string]any{"blocked_by": []any{dependencyCLIA, dependencyCLIC}, "expected_dependency_version": "opaque-v1", "title": "atomic", "suppress_run": true}, 1},
		{"clear", "PATCH", "/api/issues/" + dependencyCLIB + "/with-dependencies", []string{"update", dependencyCLIB, "--clear-blocked-by"}, map[string]any{"blocked_by": []any{}, "expected_dependency_version": "opaque-v1"}, 1},
		{"add", "PATCH", "/api/issues/" + dependencyCLIB + "/with-dependencies", []string{"dependency", "add", dependencyCLIB, "--blocked-by", dependencyCLIC, "--blocked-by", dependencyCLIA}, map[string]any{"blocked_by": []any{dependencyCLIA, dependencyCLIC}, "expected_dependency_version": "opaque-v1"}, 1},
		{"remove", "PATCH", "/api/issues/" + dependencyCLIB + "/with-dependencies", []string{"dependency", "remove", dependencyCLIB, "--blocked-by", dependencyCLIA}, map[string]any{"blocked_by": []any{}, "expected_dependency_version": "opaque-v1"}, 1},
		{"ordinary_create", "POST", "/api/issues", []string{"create", "--title", "ordinary"}, map[string]any{"title": "ordinary"}, 0},
		{"ordinary_update", "PUT", "/api/issues/" + dependencyCLIB, []string{"update", dependencyCLIB, "--title", "ordinary"}, map[string]any{"title": "ordinary"}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var reads, writes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer mat_dependency_test" || r.Header.Get("X-Workspace-ID") != dependencyCLIActor {
					t.Error("missing task credential or workspace")
				}
				switch {
				case r.Method == "GET" && r.URL.Path == "/api/issues/DEP-1":
					_ = json.NewEncoder(w).Encode(map[string]any{"id": dependencyCLIA, "identifier": "DEP-1"})
				case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/dependencies"):
					reads.Add(1)
					_ = json.NewEncoder(w).Encode(dependencyCLIView())
				case r.Method == tc.method && r.URL.Path == tc.path:
					writes.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					for key, want := range tc.fields {
						if !reflect.DeepEqual(body[key], want) {
							t.Errorf("%s=%#v want=%#v", key, body[key], want)
						}
					}
					if strings.HasPrefix(tc.name, "ordinary") && len(body) != 1 {
						t.Errorf("ordinary request changed: %v", body)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"id": dependencyCLIB, "identifier": "DEP-2", "dependencies": dependencyCLIView(), "dispatch": map[string]any{"status": "deferred", "reason_code": "no_execution"}})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			out, _ := callDependencyCLI(t, server.URL, 0, append([]string{"issue"}, tc.args...)...)
			if !strings.Contains(out, "future_field") || !strings.Contains(out, "dispatch") || int(reads.Load()) != tc.reads || writes.Load() != 1 {
				t.Fatalf("response/count mismatch: reads=%d writes=%d out=%s", reads.Load(), writes.Load(), out)
			}
		})
	}
}

func TestDependencyCLIFailureSemantics(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		status, exit int
	}{
		{"blocked", "dependency_unsatisfied", 409, 1},
		{"stale", "dependency_version_conflict", 409, 1},
		{"remove_permission", "dependency_change_not_allowed", 403, 3},
		{"cycle", "dependency_cycle", 409, 1},
		{"unverified", "dependency_data_unverified", 422, 5},
		{"old_404", "not_found", 404, 4},
		{"old_405", "", 405, 1},
	} {
		for _, action := range []string{"create", "update"} {
			t.Run(tc.name+"/"+action, func(t *testing.T) {
				var writes atomic.Int32
				view := dependencyCLIView()
				payload := map[string]any{"error": "request refused", "reason_code": tc.reason, "dependencies": view, "future_field": strings.Repeat("x", 6000)}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method == "GET" {
						_ = json.NewEncoder(w).Encode(view)
						return
					}
					writes.Add(1)
					if !strings.HasSuffix(r.URL.Path, "/with-dependencies") {
						t.Error("unsafe fallback", r.URL.Path)
					}
					w.WriteHeader(tc.status)
					_ = json.NewEncoder(w).Encode(payload)
				}))
				defer server.Close()
				args := []string{"issue", "create", "--title", "rejected", "--blocked-by", dependencyCLIA}
				if action == "update" {
					args = []string{"issue", "update", dependencyCLIB, "--clear-blocked-by"}
				}
				out, stderr := callDependencyCLI(t, server.URL, tc.exit, args...)
				var got map[string]any
				decodeErr := json.Unmarshal([]byte(out), &got)
				wantJSON, _ := json.Marshal(payload)
				gotJSON, _ := json.Marshal(got)
				if decodeErr != nil || !bytes.Equal(wantJSON, gotJSON) || writes.Load() != 1 {
					t.Fatalf("lost error or retried: writes=%d out=%s", writes.Load(), out)
				}
				if tc.status == 404 || tc.status == 405 {
					if !strings.Contains(stderr, "no fallback") {
						t.Fatal(stderr)
					}
				} else if !strings.Contains(stderr, tc.reason) {
					t.Fatal(stderr)
				}
			})
		}
	}
}

func TestDependencyCLIReadAndMalformedResponses(t *testing.T) {
	for _, output := range []string{"json", "table"} {
		t.Run(output, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(dependencyCLIView())
			}))
			defer server.Close()
			out, _ := callDependencyCLI(t, server.URL, 0, "issue", "dependency", "list", dependencyCLIB, "--output", output)
			want := "inherited_blocked_by"
			if output == "table" {
				want = "Unfinished prerequisites: 2"
			}
			if !strings.Contains(out, want) {
				t.Fatal(out)
			}
		})
	}
	for _, key := range []string{"blocked_by", "inherited_blocked_by", "unsatisfied", "blocking", "has_restricted_blockers", "dependency_version"} {
		t.Run("missing_"+key, func(t *testing.T) {
			var writes atomic.Int32
			view := dependencyCLIView()
			delete(view, key)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					writes.Add(1)
				}
				_ = json.NewEncoder(w).Encode(view)
			}))
			defer server.Close()
			_, stderr := callDependencyCLI(t, server.URL, 1, "issue", "dependency", "add", dependencyCLIB, "--blocked-by", dependencyCLIC)
			if writes.Load() != 0 || !strings.Contains(stderr, "readiness is unknown") {
				t.Fatalf("writes=%d stderr=%s", writes.Load(), stderr)
			}
		})
	}
}

func TestDependencyCLIInvalidFlagsDoNotWrite(t *testing.T) {
	for i, args := range [][]string{
		{"create", "--title", "x", "--blocked-by", ""},
		{"create", "--title", "x", "--depends-on", dependencyCLIA},
		{"update", dependencyCLIB, "--blocked-by", dependencyCLIA, "--clear-blocked-by"},
		{"update", dependencyCLIB, "--clear-blocked-by=false"},
		{"dependency", "add", dependencyCLIB},
		{"dependency", "remove", dependencyCLIB, "--blocked-by", ""},
		{"dependency", "add", dependencyCLIB, "--blocked-by", "not-an-issue"},
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			callDependencyCLI(t, "http://127.0.0.1:1", 1, append([]string{"issue"}, args...)...)
		})
	}
}

func TestDependencyCLICommentPartialSuccess(t *testing.T) {
	for _, output := range []string{"json", "table"} {
		t.Run(output, func(t *testing.T) {
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				posts.Add(1)
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(map[string]any{"id": dependencyCLIChild, "content": "saved", "trigger_outcomes": []any{
					map[string]any{"status": "blocked", "reason_code": "dependency_unsatisfied", "target_id": dependencyCLIActor, "target_type": "agent"},
					map[string]any{"status": "queued", "reason_code": "queued", "target_id": dependencyCLIC, "target_type": "agent"},
				}})
			}))
			defer server.Close()
			out, stderr := callDependencyCLI(t, server.URL, 1, "issue", "comment", "add", dependencyCLIB, "--content-file", "./comment.md", "--output", output)
			if posts.Load() != 1 || !strings.Contains(stderr, "1 target(s) not started") || !strings.Contains(stderr, "Do not repost") || !strings.Contains(stderr, "dependency_unsatisfied") {
				t.Fatalf("posts=%d stderr=%s", posts.Load(), stderr)
			}
			if output == "json" && (!strings.Contains(out, "trigger_outcomes") || !strings.Contains(out, "queued") || !json.Valid([]byte(out))) {
				t.Fatal(out)
			}
		})
	}
}

func TestDependencyCLIReadRefusalsDoNotMutate(t *testing.T) {
	for _, status := range []int{404, 405} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/dependencies") {
					t.Error("read refusal must prevent any mutation", r.Method, r.URL.Path)
				}
				http.Error(w, "not supported", status)
			}))
			defer server.Close()
			wantExit := 1
			if status == 404 {
				wantExit = 4
			}
			out, stderr := callDependencyCLI(t, server.URL, wantExit, "issue", "update", dependencyCLIB, "--clear-blocked-by")
			if requests.Load() != 1 || !json.Valid([]byte(out)) || !strings.Contains(stderr, "no fallback") {
				t.Fatalf("requests=%d out=%s stderr=%s", requests.Load(), out, stderr)
			}
		})
	}
}

func TestDependencyCLIInheritedRemovalDoesNotMutate(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != "GET" {
			t.Error("inherited removal sent a write")
		}
		_ = json.NewEncoder(w).Encode(dependencyCLIView())
	}))
	defer server.Close()
	_, stderr := callDependencyCLI(t, server.URL, 1, "issue", "dependency", "remove", dependencyCLIB, "--blocked-by", dependencyCLIC)
	if requests.Load() != 1 || !strings.Contains(stderr, "is inherited") {
		t.Fatal(requests.Load(), stderr)
	}
}

func TestDependencyCLILegacyDispatchRefusals(t *testing.T) {
	for _, args := range [][]string{{"issue", "status", dependencyCLIB, "todo", "--output", "json"}, {"issue", "rerun", dependencyCLIB}, {"issue", "assign", dependencyCLIB, "--to-id", dependencyCLIActor}} {
		t.Run(args[1], func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					actors := []map[string]any{}
					if r.URL.Path == "/api/agents" {
						actors = append(actors, map[string]any{"id": dependencyCLIActor, "name": "test agent"})
					}
					_ = json.NewEncoder(w).Encode(actors)
					return
				}
				requests.Add(1)
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "blocked", "reason_code": "dependency_unsatisfied", "dependencies": dependencyCLIView()})
			}))
			defer server.Close()
			out, stderr := callDependencyCLI(t, server.URL, 1, args...)
			if requests.Load() != 1 || !strings.Contains(out, "dependency_unsatisfied") || !strings.Contains(stderr, "request human handling") {
				t.Fatalf("requests=%d out=%s stderr=%s", requests.Load(), out, stderr)
			}
		})
	}
}

func TestDependencyCLIOversizedRefusals(t *testing.T) {
	for _, tc := range []struct {
		name, body   string
		status, exit int
	}{
		{"large_json", `{"error":"` + strings.Repeat("x", 1<<20) + `","reason_code":"dependency_unsatisfied"}`, 403, 3},
		// A valid JSON prefix followed by excessive whitespace is still oversized.
		{"valid_prefix", `{"reason_code":"dependency_unsatisfied"}` + strings.Repeat(" ", 1<<20), 409, 1},
	} {
		for _, action := range []string{"create", "status"} {
			for _, output := range []string{"json", "table"} {
				t.Run(tc.name+"/"+action+"/"+output, func(t *testing.T) {
					var requests atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						requests.Add(1)
						w.WriteHeader(tc.status)
						_, _ = w.Write([]byte(tc.body))
					}))
					defer server.Close()
					args := []string{"issue", "create", "--title", "rejected", "--blocked-by", dependencyCLIA}
					if action == "status" {
						args = []string{"issue", "status", dependencyCLIB, "todo"}
					}
					out, stderr := callDependencyCLI(t, server.URL, tc.exit, append(args, "--output", output)...)
					if requests.Load() != 1 || !strings.Contains(stderr, "exceeded 1 MiB") || !strings.Contains(stderr, "Do not retry") {
						t.Fatalf("requests=%d stderr=%.300s", requests.Load(), stderr)
					}
					if output == "json" {
						var result map[string]any
						if err := json.Unmarshal([]byte(out), &result); err != nil || result["body_truncated"] != true || result["http_status"] != float64(tc.status) || result["reason_code"] != nil || !strings.Contains(strVal(result, "error"), "exceeded 1 MiB") {
							t.Fatalf("missing local truncation diagnostic: %.300s", out)
						}
					} else if out != "" {
						t.Fatalf("table refusal should only print guidance on stderr: %.300s", out)
					}
				})
			}
		}
	}
}
