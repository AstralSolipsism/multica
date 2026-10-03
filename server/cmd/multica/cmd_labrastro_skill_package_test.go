package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

const skillPackageTestID = "10000000-0000-4000-8000-000000000001"
const skillPackageTestURL = "https://github.com/example/skills"

func skillPackageFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "labrastro-skill-package-"+name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]any
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

type skillPackageTestRequest struct {
	method, path string
	body         map[string]any
}

func serveSkillPackageFixture(t *testing.T, preview, report map[string]any, applyStatus int) func() []skillPackageTestRequest {
	t.Helper()
	var mu sync.Mutex
	var requests []skillPackageTestRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Workspace-ID") != "offline-workspace" || r.Header.Get("Authorization") != "Bearer mat_offline_test" {
			t.Error("request did not use configured workspace and credentials")
		}
		var body map[string]any
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode request: %v", err)
			}
		}
		mu.Lock()
		requests = append(requests, skillPackageTestRequest{r.Method, r.URL.Path, body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		var response any
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/skill-packages":
			response = map[string]any{"packages": []any{report["package"]}}
		case r.Method == http.MethodGet && r.URL.Path == "/api/skill-packages/"+skillPackageTestID:
			response = report["package"]
		case r.Method == http.MethodPost && (r.URL.Path == "/api/skill-packages/preview" || r.URL.Path == "/api/skill-packages/"+skillPackageTestID+"/rescan" && body["apply"] != true):
			response = preview
		case r.Method == http.MethodPost && (r.URL.Path == "/api/skill-packages/apply" || r.URL.Path == "/api/skill-packages/"+skillPackageTestID+"/rescan" && body["apply"] == true):
			w.WriteHeader(applyStatus)
			response = report
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "offline-workspace")
	t.Setenv("MULTICA_TOKEN", "mat_offline_test")
	return func() []skillPackageTestRequest {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(requests)
	}
}

func executeSkillPackage(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	root := &cobra.Command{Use: "multica", SilenceUsage: true, SilenceErrors: true}
	root.PersistentFlags().String("server-url", "", "")
	root.PersistentFlags().String("workspace-id", "", "")
	root.PersistentFlags().String("profile", "", "")
	skill := &cobra.Command{Use: "skill"}
	skill.AddCommand(newSkillPackageCmd())
	root.AddCommand(skill)
	var stdout, stderr bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stderr)
	root.SetArgs(append([]string{"skill", "package"}, args...))
	err := root.Execute()
	return stdout.String(), stderr.String(), err
}

func assertSkillPackageJSON(t *testing.T, output string, want any) {
	t.Helper()
	var got any
	if err := json.Unmarshal([]byte(output), &got); err != nil {
		t.Fatalf("stdout is not a single JSON document: %v\n%s", err, output)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stdout lost or changed response fields:\ngot %#v\nwant %#v", got, want)
	}
}

func TestLabrastroSkillPackageRegistration(t *testing.T) {
	for _, action := range []string{"import", "list", "get", "rescan"} {
		cmd, _, err := rootCmd.Find([]string{"skill", "package", action})
		if err != nil || cmd.Name() != action {
			t.Fatalf("command %s not registered: %v", action, err)
		}
	}
}

func TestLabrastroSkillPackageImportSelection(t *testing.T) {
	for _, tc := range []struct {
		name  string
		flags []string
		want  map[string]any
	}{
		{"manifest defaults", nil, map[string]any{"on_conflict": "skip"}},
		{"explicit directories", []string{"--skill", "skills/optional", "--skill", "skills/broken"}, map[string]any{"on_conflict": "skip", "skills": []any{"skills/optional", "skills/broken"}}},
		{"all includes failures", []string{"--all"}, map[string]any{"on_conflict": "skip", "all": true}},
		{"root and comma are literal", []string{"--skill", "", "--skill", "skills/a,b"}, map[string]any{"on_conflict": "skip", "skills": []any{"", "skills/a,b"}}},
		{"rename without target permission", []string{"--skill", "skills/optional", "--on-conflict", "rename"}, map[string]any{"on_conflict": "rename", "skills": []any{"skills/optional"}}},
		{"overwrite", []string{"--all", "--on-conflict", "overwrite"}, map[string]any{"on_conflict": "overwrite", "all": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
			if tc.name == "rename without target permission" {
				c := preview["candidates"].([]any)[1].(map[string]any)
				c["state"], c["conflict"], c["can_write"] = "conflict", "name_conflict", false
			}
			requests := serveSkillPackageFixture(t, preview, report, 200)
			out, _, err := executeSkillPackage(t, append([]string{"import", skillPackageTestURL}, tc.flags...)...)
			if err != nil {
				t.Fatal(err)
			}
			assertSkillPackageJSON(t, out, report)
			got := requests()
			if len(got) != 2 || got[0].path != "/api/skill-packages/preview" || got[1].path != "/api/skill-packages/apply" {
				t.Fatalf("requests = %#v", got)
			}
			if !reflect.DeepEqual(got[0].body, map[string]any{"url": skillPackageTestURL}) {
				t.Fatalf("preview request = %#v", got[0].body)
			}
			tc.want["url"], tc.want["preview_id"] = nestedMap(preview, "source")["url"], preview["preview_id"]
			if !reflect.DeepEqual(got[1].body, tc.want) {
				t.Fatalf("apply body = %#v, want %#v", got[1].body, tc.want)
			}
		})
	}
}

func TestLabrastroSkillPackageReadOnlyPreview(t *testing.T) {
	for _, args := range [][]string{
		{"import", skillPackageTestURL, "--dry-run"},
		{"import", skillPackageTestURL, "--dry-run", "--all", "--on-conflict", "overwrite"},
		{"rescan", skillPackageTestID},
		{"rescan", skillPackageTestID, "--all", "--on-conflict", "overwrite"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			preview := skillPackageFixture(t, "preview")
			requests := serveSkillPackageFixture(t, preview, nil, 200)
			out, _, err := executeSkillPackage(t, args...)
			if err != nil {
				t.Fatal(err)
			}
			assertSkillPackageJSON(t, out, preview)
			got := requests()
			if len(got) != 1 || got[0].body["apply"] != nil || strings.HasSuffix(got[0].path, "/apply") {
				t.Fatalf("read-only preview sent a write: %#v", got)
			}
		})
	}
}

func TestLabrastroSkillPackageEmptyDefaults(t *testing.T) {
	preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
	for _, item := range preview["candidates"].([]any) {
		item.(map[string]any)["default_selected"] = false
	}
	delete(report, "package")
	for _, item := range report["results"].([]any) {
		m := item.(map[string]any)
		m["status"], m["code"] = "skipped", "not_selected"
		delete(m, "skill_id")
	}
	requests := serveSkillPackageFixture(t, preview, report, 200)
	out, _, err := executeSkillPackage(t, "import", skillPackageTestURL)
	if err != nil {
		t.Fatal(err)
	}
	assertSkillPackageJSON(t, out, report)
	if got := requests()[1].body; got["skills"] != nil || got["all"] != nil {
		t.Fatalf("empty server selection was replaced: %#v", got)
	}
}

func TestLabrastroSkillPackageRescanSelectionAndRetention(t *testing.T) {
	for _, flags := range [][]string{nil, {"--skill", "skills/optional"}, {"--all"}} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
			preview["package"] = report["package"]
			candidates := preview["candidates"].([]any)
			candidates[0].(map[string]any)["state"] = "changed"
			candidates[2].(map[string]any)["state"] = "removed"
			items := report["results"].([]any)
			items[0].(map[string]any)["status"] = "updated"
			retained := items[2].(map[string]any)
			retained["status"], retained["code"], retained["skill_id"] = "retained", "source_removed", "old-skill-id"
			requests := serveSkillPackageFixture(t, preview, report, 200)
			out, _, err := executeSkillPackage(t, append([]string{"rescan", skillPackageTestID, "--apply"}, flags...)...)
			if err != nil {
				t.Fatal(err)
			}
			assertSkillPackageJSON(t, out, report)
			got := requests()
			if len(got) != 2 || got[0].path != got[1].path || got[0].path != "/api/skill-packages/"+skillPackageTestID+"/rescan" || len(got[0].body) != 0 {
				t.Fatalf("rescan requests = %#v", got)
			}
			want := map[string]any{"apply": true, "preview_id": preview["preview_id"], "on_conflict": "skip"}
			if len(flags) > 0 && flags[0] == "--skill" {
				want["skills"] = []any{"skills/optional"}
			} else if len(flags) > 0 {
				want["all"] = true
			}
			if !reflect.DeepEqual(got[1].body, want) {
				t.Fatalf("rescan selection = %#v, want %#v", got[1].body, want)
			}
		})
	}
}

func TestLabrastroSkillPackageInvalidFlagsMakeNoRequests(t *testing.T) {
	requests := serveSkillPackageFixture(t, nil, nil, 200)
	for _, args := range [][]string{
		{"import", skillPackageTestURL, "--skill", "skills/one", "--all"},
		{"import", skillPackageTestURL, "--skill", "skills/one", "--all=false"},
		{"rescan", skillPackageTestID, "--skill", "skills/one", "--all"},
		{"import", skillPackageTestURL, "--on-conflict", "fail"},
		{"rescan", skillPackageTestID, "--on-conflict", "invalid"},
		{"import", skillPackageTestURL, "--output", "yaml"},
		{"import", skillPackageTestURL, "--dry-run", "--apply"},
		{"rescan", skillPackageTestID, "--dry-run", "--apply"},
		{"get", "../skills"}, {"rescan", "not-a-uuid"}, {"list", "extra"}, {"import"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			_, _, err := executeSkillPackage(t, args...)
			if err == nil {
				t.Fatal("expected argument error")
			}
		})
	}
	if len(requests()) != 0 {
		t.Fatalf("invalid flags sent requests: %#v", requests())
	}
}

func TestLabrastroSkillPackageMalformedPreviewNeverApplies(t *testing.T) {
	for _, corrupt := range []string{"null", "missing token", "missing candidates", "invalid selection", "unknown state", "missing source", "malformed diagnostics", "duplicate path", "null shared files"} {
		t.Run(corrupt, func(t *testing.T) {
			preview := skillPackageFixture(t, "preview")
			c := preview["candidates"].([]any)[0].(map[string]any)
			switch corrupt {
			case "null":
				preview = nil
			case "missing token":
				delete(preview, "preview_id")
			case "missing candidates":
				delete(preview, "candidates")
			case "invalid selection":
				c["default_selected"] = "true"
			case "unknown state":
				c["state"] = "future_state"
			case "missing source":
				delete(preview, "source")
			case "malformed diagnostics":
				c["diagnostics"] = []any{map[string]any{"code": "bad", "message": float64(17)}}
			case "duplicate path":
				preview["candidates"] = append(preview["candidates"].([]any), c)
			case "null shared files":
				c["shared_files"] = nil
			}
			requests := serveSkillPackageFixture(t, preview, nil, 200)
			out, _, err := executeSkillPackage(t, "import", skillPackageTestURL, "--all")
			if err == nil || cli.ExitCodeFor(err) == 0 || len(requests()) != 1 {
				t.Fatalf("unsafe malformed preview: err=%v, requests=%#v", err, requests())
			}
			// Preserve even the malformed response for inspection.
			if preview == nil {
				assertSkillPackageJSON(t, out, nil)
			} else {
				assertSkillPackageJSON(t, out, preview)
			}
		})
	}
}

func TestLabrastroSkillPackageFailureReportBeforeError(t *testing.T) {
	for _, mode := range []string{"partial", "inconsistent failed flag", "unknown item status", "missing failed", "null results", "incomplete results", "stale", "forbidden"} {
		t.Run(mode, func(t *testing.T) {
			preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
			status := 200
			item := report["results"].([]any)[3].(map[string]any)
			switch mode {
			case "partial", "inconsistent failed flag":
				item["status"], item["code"], item["reason"], item["retryable"] = "failed", "item_failed", "fixture failure", true
				report["failed"] = mode == "partial"
			case "unknown item status":
				item["status"] = "future_status"
			case "missing failed":
				delete(report, "failed")
			case "null results":
				report["results"] = nil
			case "incomplete results":
				report["results"] = []any{}
			case "stale", "forbidden":
				status = 409
				if mode == "forbidden" {
					status = 403
				}
				report = map[string]any{"code": mode, "error": "preview or permissions changed", "retryable": true}
			}
			requests := serveSkillPackageFixture(t, preview, report, status)
			out, _, err := executeSkillPackage(t, "import", skillPackageTestURL, "--all")
			assertSkillPackageJSON(t, out, report)
			if err == nil || cli.ExitCodeFor(err) == 0 || !strings.Contains(cli.FormatError(err, false), "Preview again") {
				t.Fatalf("failure was not actionable/nonzero: %v", err)
			}
			if len(requests()) != 2 {
				t.Fatalf("write was retried: %#v", requests())
			}
		})
	}
}

func TestLabrastroSkillPackagePartialFailureTableStillPrintsJSON(t *testing.T) {
	preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
	report["failed"] = true
	report["results"].([]any)[3].(map[string]any)["status"] = "failed"
	serveSkillPackageFixture(t, preview, report, 200)
	out, _, err := executeSkillPackage(t, "import", skillPackageTestURL, "--all", "--output", "table")
	if err == nil {
		t.Fatal("expected partial failure")
	}
	assertSkillPackageJSON(t, out, report)
}

func TestLabrastroSkillPackageMalformedReadAndJSON(t *testing.T) {
	for _, args := range [][]string{{"list"}, {"get", skillPackageTestID}, {"import", skillPackageTestURL}} {
		for _, body := range []string{`null`, `{}`, `{"packages":null}`, `{"preview_id":`} {
			t.Run(strings.Join(args, " ")+body, func(t *testing.T) {
				calls := 0
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					_, _ = io.WriteString(w, body)
				}))
				t.Cleanup(srv.Close)
				t.Setenv("MULTICA_SERVER_URL", srv.URL)
				t.Setenv("MULTICA_TOKEN", "mat_offline_test")
				_, _, err := executeSkillPackage(t, args...)
				if err == nil || calls != 1 {
					t.Fatalf("malformed response was accepted or retried: err=%v calls=%d", err, calls)
				}
			})
		}
	}
}

func TestLabrastroSkillPackageOutputAndCWD(t *testing.T) {
	preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
	preview["candidates"].([]any)[1].(map[string]any)["name"] = "selected"
	requests := serveSkillPackageFixture(t, preview, report, 200)
	for _, dir := range []string{t.TempDir(), filepath.Join(t.TempDir(), "unrelated", "nested")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		t.Run(dir, func(t *testing.T) {
			t.Chdir(dir)
			out, stderr, err := executeSkillPackage(t, "import", skillPackageTestURL, "--dry-run")
			if err != nil || !strings.Contains(stderr, "name_conflict") || !strings.Contains(stderr, "--on-conflict rename") {
				t.Fatalf("duplicate warning missing: %v, %q", err, stderr)
			}
			assertSkillPackageJSON(t, out, preview)
			out, _, err = executeSkillPackage(t, "rescan", skillPackageTestID, "--output", "table")
			if err != nil || !strings.Contains(out, "DEFAULT") || !strings.Contains(out, "required_reference_unavailable") || !strings.Contains(out, "references/guide.md") || !strings.Contains(out, "retryable=true") {
				t.Fatalf("table lost preview diagnostics: %v, %s", err, out)
			}
			out, _, err = executeSkillPackage(t, "import", skillPackageTestURL, "--output", "table")
			if err != nil || !strings.Contains(out, "not_selected") || !strings.Contains(out, "required_reference_unavailable") {
				t.Fatalf("table lost unselected item diagnostics: %v, %s", err, out)
			}
			out, _, err = executeSkillPackage(t, "list", "--output", "json")
			if err != nil {
				t.Fatal(err)
			}
			assertSkillPackageJSON(t, out, map[string]any{"packages": []any{report["package"]}})
			out, _, err = executeSkillPackage(t, "get", skillPackageTestID, "--output", "table")
			if err != nil || !strings.Contains(out, "LAST APPLIED") || !strings.Contains(out, "skills/selected") {
				t.Fatalf("get table: %v, %s", err, out)
			}
		})
	}
	if len(requests()) != 12 {
		t.Fatalf("unexpected requests: %#v", requests())
	}
}

// Run main in a test subprocess to verify the actual process exit and streams,
// without building/installing a runtime CLI or contacting a real workspace.
func TestLabrastroSkillPackageProcess(t *testing.T) {
	if os.Getenv("LABRASTRO_SKILL_PACKAGE_TEST_PROCESS") != "1" {
		return
	}
	// TestMain clears ambient Multica settings; restore only synthetic values.
	t.Setenv("MULTICA_SERVER_URL", os.Getenv("LABRASTRO_SKILL_PACKAGE_TEST_URL"))
	t.Setenv("MULTICA_TOKEN", "mat_offline_test")
	t.Setenv("MULTICA_WORKSPACE_ID", "offline-workspace")
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", t.TempDir())
	t.Setenv("MULTICA_TASK_ID", skillPackageTestID)
	separator := slices.Index(os.Args, "--")
	os.Args = append([]string{"multica"}, os.Args[separator+1:]...)
	main()
	os.Exit(0)
}

func TestLabrastroSkillPackageProcessExit(t *testing.T) {
	preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
	report["failed"] = true
	report["results"].([]any)[3].(map[string]any)["status"] = "failed"
	requests := serveSkillPackageFixture(t, preview, report, 200)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLabrastroSkillPackageProcess$", "--", "skill", "package", "import", skillPackageTestURL, "--all", "--output", "json")
	cmd.Dir = t.TempDir()
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"), "LABRASTRO_SKILL_PACKAGE_TEST_PROCESS=1",
		"LABRASTRO_SKILL_PACKAGE_TEST_URL=" + os.Getenv("MULTICA_SERVER_URL"),
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if err == nil || cmd.ProcessState.ExitCode() != cli.ExitGeneric {
		t.Fatalf("exit = %v, state = %v, stderr = %s", err, cmd.ProcessState, stderr.String())
	}
	assertSkillPackageJSON(t, stdout.String(), report)
	if !strings.Contains(stderr.String(), "Preview again") || len(requests()) != 2 {
		t.Fatalf("failure stderr/retries: %s, %#v", stderr.String(), requests())
	}
}

type skillPackageRoundTripper func(*http.Request) (*http.Response, error)

func (f skillPackageRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLabrastroSkillPackageRequestDeadline(t *testing.T) {
	t.Setenv("MULTICA_HTTP_TIMEOUT", "10m")
	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())
	cmd.SetOut(io.Discard)
	client := cli.NewAPIClient("https://offline.invalid", "offline-workspace", "mat_offline_test")
	var deadlines []time.Time
	client.HTTPClient.Transport = skillPackageRoundTripper(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 45*time.Second || time.Until(deadline) < 44*time.Second {
			t.Errorf("unexpected request deadline: %v", deadline)
		}
		deadlines = append(deadlines, deadline)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
	})
	for range 2 {
		if _, err := requestSkillPackage(cmd, client, "/api/skill-packages/preview", map[string]any{}); err != nil {
			t.Fatal(err)
		}
	}
	if !deadlines[1].After(deadlines[0]) {
		t.Fatal("preview and apply did not receive separate request budgets")
	}
}

func TestLabrastroSkillSingleImportRefreshDiagnostics(t *testing.T) {
	diagnostic := map[string]any{"code": "tree_incomplete", "path": "SKILL.md", "message": "References could not be completed", "retryable": true}
	skill := map[string]any{"id": "old-skill", "name": "old", "diagnostics": []any{diagnostic}}
	for _, result := range []map[string]any{skill, {"status": "created", "skill": skill}} {
		cmd := &cobra.Command{}
		cmd.Flags().String("output", "table", "")
		out, err := captureStdout(t, func() error { return printSkillImportResult(cmd, result) })
		if err != nil || !strings.Contains(out, "tree_incomplete") || !strings.Contains(out, "References could not be completed") {
			t.Fatalf("import diagnostics: %v, %s", err, out)
		}
		_ = cmd.Flags().Set("output", "json")
		out, err = captureStdout(t, func() error { return printSkillImportResult(cmd, result) })
		if err != nil {
			t.Fatal(err)
		}
		assertSkillPackageJSON(t, out, result)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/skills/old-skill/refresh" {
			t.Errorf("refresh path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(skill)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_offline_test")
	t.Setenv("MULTICA_WORKSPACE_ID", "offline-workspace")
	cmd := &cobra.Command{}
	cmd.Flags().String("output", "table", "")
	out, err := captureStdout(t, func() error { return runSkillRefresh(cmd, []string{"old-skill"}) })
	if err != nil || !strings.Contains(out, "tree_incomplete") || !strings.Contains(out, "retryable=true") {
		t.Fatalf("refresh diagnostics: %v, %s", err, out)
	}
}
