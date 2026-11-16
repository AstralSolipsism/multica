package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/spf13/cobra"
)

const migrationSourceWS = "20000000-0000-4000-8000-000000000001"
const migrationTargetWS = "20000000-0000-4000-8000-000000000002"
const migrationFolderID = "20000000-0000-4000-8000-000000000003"
const migrationSkillID = "20000000-0000-4000-8000-000000000004"

func skillFolderSnapshotFixture() map[string]any {
	return map[string]any{"schema_version": float64(1), "exported_at": "2026-11-16T00:00:00Z", "source_workspace_id": migrationSourceWS, "folders": []any{map[string]any{"id": migrationFolderID, "parent_id": nil, "name": "Engineering", "package_id": nil, "package_path": nil}}, "packages": []any{}, "placements": []any{}}
}
func skillFolderPlanFixture() map[string]any {
	return map[string]any{"preview_id": "signed-plan", "can_apply": true, "changed": false, "summary": map[string]any{"create": float64(1), "reuse": float64(0), "update": float64(0), "place": float64(0), "move": float64(0), "unchanged": float64(0), "skipped": float64(0), "conflicts": float64(0), "target_only_skills": float64(0), "target_only_folders": float64(0), "target_only_packages": float64(0), "target_only_placements": float64(0)}, "folders": []any{map[string]any{"id": migrationFolderID, "source_id": migrationFolderID, "parent_id": nil, "name": "Engineering", "package_id": nil, "package_path": nil, "action": "create"}}, "packages": []any{}, "placements": []any{}, "conflicts": []any{}}
}
func skillFolderSnapshotFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "snapshot.json")
	b, _ := json.Marshal(skillFolderSnapshotFixture())
	if err := os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
	return file
}
func executeSkillFolder(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	root := &cobra.Command{Use: "multica", SilenceUsage: true, SilenceErrors: true}
	root.PersistentFlags().String("server-url", "", "")
	root.PersistentFlags().String("workspace-id", "", "")
	root.PersistentFlags().String("profile", "", "")
	root.AddCommand(newSkillFolderCmd())
	var out, stderr bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&stderr)
	root.SetArgs(append([]string{"folder"}, args...))
	err := root.Execute()
	return out.String(), stderr.String(), err
}

type folderTestRequest struct {
	method, path, workspace string
	body                    map[string]any
}

func serveSkillFolder(t *testing.T, reply func(http.ResponseWriter, *http.Request, map[string]any)) func() []folderTestRequest {
	t.Helper()
	var mu sync.Mutex
	requests := []folderTestRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mat_folder_test" {
			t.Error("credentials changed across workspace requests")
		}
		var body map[string]any
		if r.Method == "POST" {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
		}
		mu.Lock()
		requests = append(requests, folderTestRequest{r.Method, r.URL.Path, r.Header.Get("X-Workspace-ID"), body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		reply(w, r, body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_folder_test")
	t.Setenv("MULTICA_WORKSPACE_ID", migrationTargetWS)
	return func() []folderTestRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]folderTestRequest{}, requests...)
	}
}
func TestLabrastroSkillFolderRegistration(t *testing.T) {
	for _, action := range []string{"tree", "export", "migrate"} {
		cmd, _, err := rootCmd.Find([]string{"skill", "folder", action})
		if err != nil || cmd.Name() != action {
			t.Fatalf("unregistered %s: %v", action, err)
		}
	}
}
func TestLabrastroSkillFolderMigrationRequests(t *testing.T) {
	for _, mode := range []string{"default", "dry-run", "apply", "explicit-token", "workspace-preview", "workspace-apply", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			plan := skillFolderPlanFixture()
			if mode == "conflict" {
				plan["can_apply"] = false
				plan["conflicts"] = []any{map[string]any{"kind": "placement", "code": "source_mismatch", "message": "different source"}}
				plan["summary"].(map[string]any)["conflicts"] = float64(1)
			}
			requests := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
				if strings.HasSuffix(r.URL.Path, "/snapshot") {
					_ = json.NewEncoder(w).Encode(skillFolderSnapshotFixture())
					return
				}
				if body["snapshot"] == nil {
					t.Error("request lost snapshot")
				}
				out := plan
				if strings.HasSuffix(r.URL.Path, "/apply") {
					out = skillFolderPlanFixture()
					out["changed"] = true
					if body["preview_id"] != "signed-plan" {
						t.Error("apply lost reviewed token")
					}
				}
				_ = json.NewEncoder(w).Encode(out)
			})
			args := []string{"migrate", "--from-file", skillFolderSnapshotFile(t)}
			if strings.HasPrefix(mode, "workspace-") {
				args = []string{"migrate", "--from-workspace", migrationSourceWS}
			}
			if mode == "dry-run" {
				args = append(args, "--dry-run")
			}
			if mode == "apply" || mode == "workspace-apply" || mode == "explicit-token" {
				args = append(args, "--apply")
			}
			if mode == "explicit-token" {
				args = append(args, "--preview-id", "signed-plan")
			}
			out, _, err := executeSkillFolder(t, args...)
			if (err != nil) != (mode == "conflict") {
				t.Fatalf("unexpected error %v; output %s", err, out)
			}
			var document map[string]any
			if json.Unmarshal([]byte(out), &document) != nil {
				t.Fatalf("stdout not one JSON: %s", out)
			}
			calls := requests()
			writes := 0
			for i, r := range calls {
				if strings.HasSuffix(r.path, "/snapshot") {
					if r.workspace != migrationSourceWS || i != 0 {
						t.Fatalf("wrong source scope: %+v", calls)
					}
				} else if r.workspace != migrationTargetWS {
					t.Fatalf("wrong target scope: %+v", calls)
				}
				if strings.HasSuffix(r.path, "/apply") {
					writes++
				}
			}
			want := 0
			if mode == "apply" || mode == "workspace-apply" || mode == "explicit-token" {
				want = 1
			}
			if writes != want {
				t.Fatalf("writes=%d want=%d", writes, want)
			}
			expected := 1
			if mode == "apply" || mode == "workspace-preview" {
				expected = 2
			}
			if mode == "workspace-apply" {
				expected = 3
			}
			if len(calls) != expected {
				t.Fatalf("unexpected requests: %+v", calls)
			}
			if mode == "conflict" {
				assertSkillPackageJSON(t, out, plan)
			}
		})
	}
}
func TestLabrastroSkillFolderExportAndTree(t *testing.T) {
	requests := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		snapshot := skillFolderSnapshotFixture()
		switch r.URL.Path {
		case "/api/skill-folders/snapshot":
			_ = json.NewEncoder(w).Encode(snapshot)
		case "/api/skills":
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": migrationSkillID, "name": "alpha"}, map[string]any{"id": migrationSourceWS, "name": "local-only"}})
		case "/api/skill-folders":
			snapshot["folders"].([]any)[0].(map[string]any)["package_id"] = skillPackageTestID
			snapshot["folders"].([]any)[0].(map[string]any)["package_path"] = ""
			snapshot["packages"] = []any{map[string]any{"id": skillPackageTestID, "owner_repo": "example/skills", "subdirectory": "", "source_url": "https://github.com/example/skills/tree/main", "ref": "main", "root_folder_id": migrationFolderID, "candidates": []any{map[string]any{"path": "alpha", "name": "alpha"}, map[string]any{"path": "gray", "name": "gray"}}}}
			snapshot["placements"] = []any{map[string]any{"skill_id": migrationSkillID, "folder_id": migrationFolderID, "package_id": skillPackageTestID, "source_path": "alpha"}}
			_ = json.NewEncoder(w).Encode(snapshot)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	out, _, err := executeSkillFolder(t, "export")
	if err != nil {
		t.Fatal(err)
	}
	assertSkillPackageJSON(t, out, skillFolderSnapshotFixture())
	file := filepath.Join(t.TempDir(), "export.json")
	out, stderr, err := executeSkillFolder(t, "export", "--output-file", file)
	if err != nil || out != "" || !strings.Contains(stderr, file) {
		t.Fatalf("file export: %s %s %v", out, stderr, err)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	assertSkillPackageJSON(t, string(b), skillFolderSnapshotFixture())
	out, _, err = executeSkillFolder(t, "tree")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Engineering [package]", "alpha", "[not imported] gray", "Unclassified: 1", "local-only"} {
		if !strings.Contains(out, want) {
			t.Fatalf("tree missing %q: %s", want, out)
		}
	}
	for _, r := range requests() {
		if r.method != "GET" {
			t.Fatal("read command wrote")
		}
	}
}
func TestLabrastroSkillFolderRejectsFlagsAndMalformedResponses(t *testing.T) {
	calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"can_apply": true, "preview_id": "unsafe"})
	})
	file := skillFolderSnapshotFile(t)
	for _, args := range [][]string{
		{"migrate"}, {"migrate", "--from-file", file, "--from-workspace", migrationSourceWS}, {"migrate", "--from-file", file, "--dry-run", "--apply"}, {"migrate", "--from-file", file, "--preview-id", "token"}, {"migrate", "--from-workspace", migrationSourceWS, "--apply", "--preview-id", "token"}, {"migrate", "--from-workspace", "short"}, {"migrate", "--from-workspace", migrationTargetWS}, {"export", "--output", "table"}, {"tree", "--output", "yaml"},
	} {
		_, _, err := executeSkillFolder(t, args...)
		if err == nil {
			t.Errorf("accepted %v", args)
		}
	}
	if len(calls()) != 0 {
		t.Fatalf("invalid flags made requests: %+v", calls())
	}
	_, _, err := executeSkillFolder(t, "migrate", "--from-file", file, "--apply")
	if err == nil {
		t.Fatal("accepted incomplete preview")
	}
	if got := calls(); len(got) != 1 || !strings.HasSuffix(got[0].path, "/preview") {
		t.Fatalf("malformed preview applied: %+v", got)
	}
	for _, command := range []string{"tree", "export"} {
		_, _, err := executeSkillFolder(t, command)
		if err == nil {
			t.Fatalf("%s accepted malformed response", command)
		}
	}
}
func TestLabrastroSkillFolderWritesNeverRetry(t *testing.T) {
	for _, status := range []int{409, 500, 0} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			failure := map[string]any{"code": "preview_stale", "error": "preview again"}
			calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
				if status == 0 {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = conn.Close()
					return
				}
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(failure)
			})
			out, _, err := executeSkillFolder(t, "migrate", "--from-file", skillFolderSnapshotFile(t), "--apply", "--preview-id", "signed-plan")
			if err == nil || len(calls()) != 1 {
				t.Fatalf("write retry or false success: %v %+v", err, calls())
			}
			if status != 0 {
				assertSkillPackageJSON(t, out, failure)
			}
		})
	}
}
