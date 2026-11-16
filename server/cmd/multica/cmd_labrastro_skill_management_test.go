package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

const manageRoot = "a1111111-1111-4111-8111-111111111111"
const manageChild = "b2222222-2222-4222-8222-222222222222"
const manageOther = "c3333333-3333-4333-8333-333333333333"
const manageDuplicate = "d4444444-4444-4444-8444-444444444444"
const managePackageRoot = "e5555555-5555-4555-8555-555555555555"
const manageManaged = "f6666666-6666-4666-8666-666666666666"

func skillManagementTree(t *testing.T) map[string]any {
	t.Helper()
	folder := func(id, name string, parent, pkg, path any) any {
		return map[string]any{"id": id, "name": name, "parent_id": parent, "package_id": pkg, "package_path": path}
	}
	pkg := skillPackageFixture(t, "apply")["package"].(map[string]any)
	pkg["root_folder_id"] = managePackageRoot
	pkg["candidates"] = []any{
		map[string]any{"path": "skills/base", "name": "base"},
		map[string]any{"path": "skills/tools/alpha", "name": "alpha"},
		map[string]any{"path": "skills/tools/new", "name": "new"},
		map[string]any{"path": "skills/missing/fallback", "name": "fallback"},
	}
	return map[string]any{
		"folders":  []any{folder(manageRoot, "Engineering", nil, nil, nil), folder(manageChild, "Review", manageRoot, nil, nil), folder(manageOther, "Other", nil, nil, nil), folder(manageDuplicate, "Review", manageOther, nil, nil), folder(managePackageRoot, "Package", nil, skillPackageTestID, ""), folder(manageManaged, "tools", managePackageRoot, skillPackageTestID, "tools")},
		"packages": []any{pkg},
		"placements": []any{
			map[string]any{"skill_id": migrationSkillID, "folder_id": manageManaged, "package_id": skillPackageTestID, "source_path": "skills/tools/alpha"},
			map[string]any{"skill_id": migrationSourceWS, "folder_id": manageManaged, "package_id": nil, "source_path": nil},
		},
	}
}

func skillManagementSkills() []map[string]any {
	return []map[string]any{{"id": migrationSkillID, "name": "alpha"}, {"id": migrationSourceWS, "name": "detached"}, {"id": manageOther, "name": "unclassified"}}
}

func TestLabrastroSkillOrganizationRefs(t *testing.T) {
	tree := skillManagementTree(t)
	for _, tc := range []struct{ input, want, failure string }{
		{manageChild, manageChild, ""}, {strings.ToUpper(manageChild), manageChild, ""}, {"b222", manageChild, ""}, {"b2222222-2222", manageChild, ""},
		{"Engineering/Review", manageChild, ""}, {"Engineering", manageRoot, ""}, {"Review", "", "ambiguous folder name"},
		{"engineering/Review", "", "no folder found"}, {"missing", "", "no folder found"}, {"a11", "", "at least 4"}, {migrationSkillID, "", "no folder found"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			ref, err := resolveSkillOrganizationRef("folder", tc.input, skillFolderRefs(tree))
			if tc.failure == "" {
				if err != nil || ref.ID != tc.want {
					t.Fatalf("ref=%+v err=%v", ref, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.failure) {
				t.Fatalf("err=%v want %s", err, tc.failure)
			} else if tc.input == "Review" {
				for _, want := range []string{manageChild, manageDuplicate, "Engineering/Review", "Other/Review"} {
					if !strings.Contains(err.Error(), want) {
						t.Fatal(err)
					}
				}
			}
		})
	}
	candidates := []idCandidate{{ID: migrationSkillID, Display: "alpha"}, {ID: migrationSourceWS, Display: "alpha"}, {ID: manageRoot, Display: "2000"}}
	for _, input := range []string{migrationSkillID, strings.ToUpper(migrationSkillID), "a111"} {
		if _, err := resolveSkillOrganizationRef("skill", input, candidates); err != nil {
			t.Fatal(err)
		}
	}
	if ref, err := resolveSkillOrganizationRef("skill", "2000", candidates); err != nil || ref.ID != manageRoot {
		t.Fatalf("name must precede prefix: %+v %v", ref, err)
	}
	for _, input := range []string{"alpha", "200000"} {
		_, err := resolveSkillOrganizationRef("skill", input, candidates)
		if err == nil || !strings.Contains(err.Error(), "ambiguous") || !strings.Contains(err.Error(), "--full-id") {
			t.Fatalf("ambiguity: %v", err)
		}
	}
}

func TestLabrastroSkillFolderManagement(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		args               []string
		body               map[string]any
	}{
		{"create root", "POST", "/api/skill-folders", []string{"create", "--name", "New"}, map[string]any{"name": "New"}},
		{"create child", "POST", "/api/skill-folders", []string{"create", "--name", "New", "--parent", "Engineering/Review"}, map[string]any{"name": "New", "parent_id": manageChild}},
		{"rename keeps parent", "PATCH", "/api/skill-folders/" + manageChild, []string{"update", "b222", "--name", "New"}, map[string]any{"name": "New"}},
		{"move", "PATCH", "/api/skill-folders/" + manageChild, []string{"update", "Engineering/Review", "--parent", "Other"}, map[string]any{"parent_id": manageOther}},
		{"root", "PATCH", "/api/skill-folders/" + manageChild, []string{"update", manageChild, "--root"}, map[string]any{"parent_id": ""}},
		{"delete", "DELETE", "/api/skill-folders/" + manageChild, []string{"delete", "Engineering/Review"}, nil},
		{"detach", "POST", "/api/skill-placements/" + migrationSkillID + "/detach", []string{"detach-skill", "alpha"}, nil},
		{"move skill", "PUT", "/api/skill-placements/" + migrationSkillID, []string{"move-skill", "alpha", "--folder", "Engineering"}, map[string]any{"folder_id": manageRoot}},
		{"root skill", "PUT", "/api/skill-placements/" + migrationSkillID, []string{"move-skill", migrationSkillID, "--root"}, map[string]any{"folder_id": ""}},
	} {
		for _, output := range []string{"json", "table"} {
			t.Run(tc.name+output, func(t *testing.T) {
				tree := skillManagementTree(t)
				calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
					var result any
					switch {
					case r.Method == "GET" && r.URL.Path == "/api/skill-folders":
						result = tree
					case r.Method == "GET" && r.URL.Path == "/api/skills":
						result = skillManagementSkills()
					case r.Method == tc.method && r.URL.Path == tc.path:
						if strings.Contains(tc.path, "skill-placements") {
							result = map[string]any{"updated": true}
						} else if tc.method == "DELETE" {
							result = map[string]any{"deleted": true}
						} else {
							result = tree["folders"].([]any)[0]
						}
					default:
						t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					}
					_ = json.NewEncoder(w).Encode(result)
				})
				out, _, err := executeSkillFolder(t, append(tc.args, "--output", output)...)
				if err != nil {
					t.Fatal(err)
				}
				requests := calls()
				last := requests[len(requests)-1]
				if last.method != tc.method || last.path != tc.path || !reflect.DeepEqual(last.body, tc.body) {
					t.Fatalf("request: %+v want %+v", last, tc.body)
				}
				writes := 0
				for _, r := range requests {
					if r.method != "GET" {
						writes++
					}
				}
				if writes != 1 {
					t.Fatalf("writes %d", writes)
				}
				if output == "json" {
					var result map[string]any
					if json.Unmarshal([]byte(out), &result) != nil {
						t.Fatalf("bad JSON: %s", out)
					}
					if tc.name == "detach" && result["skill_id"] != migrationSkillID {
						t.Fatal(out)
					}
					if tc.name == "root skill" && result["folder_id"] != nil {
						t.Fatal(out)
					}
				} else if !strings.Contains(out, "VALUE") {
					t.Fatal(out)
				}
			})
		}
	}
}

func TestLabrastroSkillFolderReadsAndTree(t *testing.T) {
	tree := skillManagementTree(t)
	serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		if r.Method != "GET" {
			t.Errorf("read wrote %s", r.Method)
		}
		var result any = tree
		if r.URL.Path == "/api/skills" {
			result = skillManagementSkills()
		}
		_ = json.NewEncoder(w).Encode(result)
	})
	for _, action := range []string{"list", "get", "tree"} {
		args := []string{action}
		if action == "get" {
			args = append(args, "Engineering")
		}
		out, _, err := executeSkillFolder(t, append(args, "--output", "json")...)
		if err != nil {
			t.Fatal(err)
		}
		if action == "list" {
			assertSkillPackageJSON(t, out, tree["folders"])
		}
		if action == "get" {
			assertSkillPackageJSON(t, out, tree["folders"].([]any)[0])
		}
		out, _, err = executeSkillFolder(t, append(args, "--output", "table")...)
		if err != nil {
			t.Fatal(err)
		}
		if action == "get" {
			for _, want := range []string{"Engineering", "FOLDERS", "SKILLS", "PARENT_ID", "PACKAGE_ID", "custom", manageRoot} {
				if !strings.Contains(out, want) {
					t.Fatal(out)
				}
			}
		} else {
			if strings.Contains(out, manageRoot) || !strings.Contains(out, displayID(manageRoot, false)) {
				t.Fatal(out)
			}
			out, _, err = executeSkillFolder(t, append(args, "--full-id")...)
			if err != nil || !strings.Contains(out, manageRoot) {
				t.Fatalf("%s %v", out, err)
			}
		}
		if action == "list" {
			for _, want := range []string{"Engineering/Review", "package-root", "package-managed", "custom"} {
				if !strings.Contains(out, want) {
					t.Fatal(out)
				}
			}
		}
		if action == "tree" {
			for _, want := range []string{"Package (" + managePackageRoot + ") [package]", "  tools (" + manageManaged + ") [managed]", "    detached (" + migrationSourceWS + ") [detached]", "    [not imported] new (skills/tools/new)", "  [not imported] fallback (skills/missing/fallback)", "  unclassified (" + manageOther + ")"} {
				if !strings.Contains(out, want) {
					t.Fatalf("missing %q:\n%s", want, out)
				}
			}
			if strings.Contains(out, "[not imported] alpha") || strings.Index(out, "    [not imported] new") < strings.Index(out, "  tools (") {
				t.Fatal(out)
			}
		}
	}
}

func TestLabrastroSkillFolderMovePreflightAndPartialFailure(t *testing.T) {
	for _, mode := range []string{"unknown name", "unknown UUID", "ambiguous skill", "ambiguous folder", "deduplicate", "403", "409", "500", "malformed", "disconnect"} {
		t.Run(mode, func(t *testing.T) {
			tree := skillManagementTree(t)
			writes := 0
			calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
				var result any
				switch r.URL.Path {
				case "/api/skill-folders":
					result = tree
				case "/api/skills":
					skills := skillManagementSkills()
					if mode == "ambiguous skill" {
						skills = append(skills, map[string]any{"id": manageRoot, "name": "alpha"})
					}
					result = skills
				default:
					writes++
					result = map[string]any{"updated": true}
					if writes == 2 && mode != "deduplicate" {
						if mode == "disconnect" {
							conn, _, err := w.(http.Hijacker).Hijack()
							if err != nil {
								t.Error(err)
								return
							}
							conn.Close()
							return
						}
						if mode == "malformed" {
							result = map[string]any{}
						} else {
							status := 409
							fmt.Sscan(mode, &status)
							w.WriteHeader(status)
							result = map[string]any{"code": "managed_skill", "error": "detach first", "retryable": false}
						}
					}
				}
				_ = json.NewEncoder(w).Encode(result)
			})
			args := []string{"move-skill", "alpha", "detached", "unclassified", "--folder", "Engineering"}
			switch mode {
			case "unknown name":
				args[2] = "missing"
			case "unknown UUID":
				args[2] = manageDuplicate
			case "ambiguous folder":
				args[len(args)-1] = "Review"
			case "deduplicate":
				args = []string{"move-skill", "alpha", migrationSkillID, "detached", strings.ToUpper(migrationSourceWS), "--root"}
			}
			if mode == "409" {
				args = append(args, "--output", "table")
			}
			out, _, err := executeSkillFolder(t, args...)
			writeCalls := []folderTestRequest{}
			for _, r := range calls() {
				if r.method != "GET" {
					writeCalls = append(writeCalls, r)
				}
			}
			if strings.HasPrefix(mode, "unknown") || strings.HasPrefix(mode, "ambiguous") {
				if err == nil || len(writeCalls) != 0 {
					t.Fatalf("error=%v writes=%+v", err, writeCalls)
				}
				return
			}
			if len(writeCalls) != 2 {
				t.Fatalf("writes=%+v", writeCalls)
			}
			var result map[string]any
			if json.Unmarshal([]byte(out), &result) != nil {
				t.Fatal(out)
			}
			if mode == "deduplicate" {
				if err != nil || result["updated"] != true || len(result["skill_ids"].([]any)) != 2 {
					t.Fatalf("%v %s", err, out)
				}
			} else {
				if err == nil || result["updated"] != false || !reflect.DeepEqual(result["skill_ids"], []any{migrationSkillID}) || nestedMap(result, "failed")["skill_id"] != migrationSourceWS {
					t.Fatalf("%v %s", err, out)
				}
				if mode != "malformed" && mode != "disconnect" && nestedMap(nestedMap(result, "failed"), "response")["code"] != "managed_skill" {
					t.Fatal(out)
				}
			}
		})
	}
}

func TestLabrastroSkillFolderFlags(t *testing.T) {
	for _, args := range [][]string{
		{"create"}, {"update", manageRoot}, {"update", manageRoot, "--parent", manageChild, "--root"},
		{"move-skill", "alpha"}, {"move-skill", "alpha", "--root=false"}, {"move-skill", "alpha", "--root", "--folder", manageRoot}, {"move-skill", "--root"}, {"list", "--output", "yaml"},
	} {
		if _, _, err := executeSkillFolder(t, args...); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestLabrastroSkillFolderMigrationTable(t *testing.T) {
	for _, apply := range []bool{false, true} {
		t.Run(fmt.Sprint(apply), func(t *testing.T) {
			serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
				plan := skillFolderPlanFixture()
				plan["changed"] = strings.HasSuffix(r.URL.Path, "/apply")
				f := plan["folders"].([]any)[0].(map[string]any)
				f["to_path"] = "Engineering"
				pkg := skillPackageFixture(t, "apply")["package"].(map[string]any)
				pkg["owner_repo"], pkg["source_id"], pkg["action"] = "example/review", skillPackageTestID, "reuse"
				plan["packages"] = []any{pkg}
				plan["placements"] = []any{map[string]any{"skill_id": migrationSkillID, "source_skill_id": migrationSkillID, "folder_id": migrationFolderID, "package_id": nil, "source_path": nil, "skill": map[string]any{"name": "review-code"}, "action": "move", "from_path": "Before", "to_path": "Engineering"}}
				plan["summary"].(map[string]any)["reuse"] = float64(1)
				plan["summary"].(map[string]any)["move"] = float64(1)
				_ = json.NewEncoder(w).Encode(plan)
			})
			args := []string{"migrate", "--from-file", skillFolderSnapshotFile(t), "--output", "table"}
			if apply {
				args = append(args, "--apply")
			}
			out, stderr, err := executeSkillFolder(t, args...)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"KIND", "ACTION", "FROM", "TO", "CODE", "Engineering", "create", "example/review", "reuse", "review-code", "move", "Before", "Preview ID: signed-plan", fmt.Sprintf("Can apply: true; changed: %v", apply)} {
				if !strings.Contains(out, want) {
					t.Fatalf("missing %s: %s", want, out)
				}
			}
			if !apply && !strings.Contains(stderr, "Read-only preview") {
				t.Fatal(stderr)
			}
		})
	}
}

func executeSkillPackageInput(input string, args ...string) (string, string, error) {
	root := &cobra.Command{Use: "multica", SilenceUsage: true, SilenceErrors: true}
	for _, name := range []string{"server-url", "workspace-id", "profile"} {
		root.PersistentFlags().String(name, "", "")
	}
	root.AddCommand(newSkillPackageCmd())
	var out, stderr bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&stderr)
	root.SetIn(strings.NewReader(input))
	root.SetArgs(append([]string{"package"}, args...))
	err := root.Execute()
	return out.String(), stderr.String(), err
}
