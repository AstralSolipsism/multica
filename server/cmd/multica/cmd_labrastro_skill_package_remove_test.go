package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
)

func skillRemovalPreviewFixture() map[string]any {
	return map[string]any{"preview_id": "signed-delete", "skill_ids": []any{migrationSkillID}, "affected_agents": []any{map[string]any{"id": manageRoot, "name": "Reviewer", "skill_id": migrationSkillID, "skill_name": "alpha"}}, "can_delete": true}
}

func TestLabrastroSkillPackageRefs(t *testing.T) {
	for _, tc := range []struct{ input, want, failure string }{
		{skillPackageTestID, skillPackageTestID, ""}, {"1000", skillPackageTestID, ""}, {"fixture/skills:", skillPackageTestID, ""},
		{"fixture/skills:sub/deep", manageRoot, ""}, {"fixture/skills", "", "ambiguous package name"}, {"other/repo", manageOther, ""},
		{"1111", "", "no package found"}, {"not-a-uuid", "", "no package found"}, {"../skills", "", "no package found"}, {"100", "", "at least 4"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			pkg := skillPackageFixture(t, "apply")["package"].(map[string]any)
			pkg["owner_repo"] = "fixture/skills"
			pkg["subdirectory"] = ""
			sub := skillPackageFixture(t, "apply")["package"].(map[string]any)
			sub["id"], sub["owner_repo"], sub["subdirectory"] = manageRoot, "fixture/skills", "sub/deep"
			other := skillPackageFixture(t, "apply")["package"].(map[string]any)
			other["id"], other["owner_repo"] = manageOther, "other/repo"
			calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
				if r.Method != "GET" {
					t.Errorf("resolution wrote: %s", r.Method)
				}
				var response any
				switch r.URL.Path {
				case "/api/skill-packages":
					response = map[string]any{"packages": []any{pkg, sub, other}}
				case "/api/skill-packages/" + skillPackageTestID:
					response = pkg
				case "/api/skill-packages/" + manageRoot:
					response = sub
				case "/api/skill-packages/" + manageOther:
					response = other
				default:
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				_ = json.NewEncoder(w).Encode(response)
			})
			out, _, err := executeSkillPackage(t, "get", tc.input)
			if tc.failure != "" {
				if err == nil || !strings.Contains(err.Error(), tc.failure) || len(calls()) != 1 {
					t.Fatalf("%v %s %+v", err, out, calls())
				}
				if tc.input == "fixture/skills" {
					for _, want := range []string{manageRoot, skillPackageTestID, "fixture/skills:", "fixture/skills:sub/deep"} {
						if !strings.Contains(err.Error(), want) {
							t.Fatal(err)
						}
					}
				}
			} else {
				var result map[string]any
				if err != nil || json.Unmarshal([]byte(out), &result) != nil || result["id"] != tc.want {
					t.Fatalf("%v %s", err, out)
				}
			}
		})
	}
}

func TestLabrastroSkillPackageListFullIDAndRescanURL(t *testing.T) {
	preview, report := skillPackageFixture(t, "preview"), skillPackageFixture(t, "apply")
	calls := serveSkillPackageFixture(t, preview, report, 200)
	for _, full := range []bool{false, true} {
		args := []string{"list"}
		if full {
			args = append(args, "--full-id")
		}
		out, _, err := executeSkillPackage(t, args...)
		if err != nil || !strings.Contains(out, displayID(skillPackageTestID, full)) || strings.Contains(out, skillPackageTestID) != full {
			t.Fatalf("%v %s", err, out)
		}
	}
	for _, apply := range []bool{false, true} {
		args := []string{"rescan", skillPackageTestID, "--url", "https://github.com/example/skills/tree/v2"}
		if apply {
			args = append(args, "--apply")
		}
		if _, _, err := executeSkillPackage(t, args...); err != nil {
			t.Fatal(err)
		}
	}
	requests := calls()
	if len(requests) != 5 {
		t.Fatalf("%+v", requests)
	}
	for _, r := range requests[2:] {
		if r.body["url"] != "https://github.com/example/skills/tree/v2" {
			t.Fatal(r)
		}
	}
	if requests[3].body["apply"] != nil || requests[4].body["apply"] != true {
		t.Fatal(requests)
	}
}

func TestLabrastroSkillPackageRemoval(t *testing.T) {
	for _, tc := range []struct {
		name, action, input, failure string
		flags                        []string
		canDelete, write             bool
	}{
		{"delete dry run", "delete", "", "", []string{"--dry-run"}, true, false},
		{"dissolve dry run", "dissolve", "", "", []string{"--dry-run"}, false, false},
		{"dissolve", "dissolve", "", "", nil, false, true},
		{"yes flag", "delete", "", "", []string{"--yes"}, true, true},
		{"short yes", "delete", "", "", []string{"-y"}, true, true},
		{"interactive y", "delete", "y\n", "", nil, true, true},
		{"interactive yes", "delete", " YES \n", "", nil, true, true},
		{"abort", "delete", "n\n", "", nil, true, false},
		{"empty line abort", "delete", "\n", "", nil, true, false},
		{"no input", "delete", "", "no confirmation received (stdin is not interactive)", nil, true, false},
		{"cannot delete", "delete", "y\n", "cannot delete", []string{"--yes"}, false, false},
	} {
		for _, output := range []string{"json", "table"} {
			t.Run(tc.name+output, func(t *testing.T) {
				preview := skillRemovalPreviewFixture()
				preview["can_delete"] = tc.canDelete
				pkg := skillPackageFixture(t, "apply")["package"]
				calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
					var result any
					switch {
					case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/delete-preview"):
						result = preview
					case r.Method == "GET" && r.URL.Path == "/api/skill-packages/"+skillPackageTestID:
						result = pkg
					case r.Method != "GET":
						wantMethod, wantPath := "DELETE", "/api/skill-packages/"+skillPackageTestID
						if tc.action == "dissolve" {
							wantMethod, wantPath = "POST", wantPath+"/dissolve"
						}
						if !tc.write || r.Method != wantMethod || r.URL.Path != wantPath || body["preview_id"] != "signed-delete" || r.Header.Get("Content-Type") != "application/json" {
							t.Errorf("unexpected write: %s %s %+v", r.Method, r.URL.Path, body)
						}
						result = map[string]any{"deleted": tc.action == "delete", "dissolved": tc.action == "dissolve", "skill_count": 1}
					default:
						t.Errorf("unexpected read: %s", r.URL.Path)
					}
					_ = json.NewEncoder(w).Encode(result)
				})
				args := append([]string{tc.action, skillPackageTestID, "--output", output}, tc.flags...)
				out, stderr, err := executeSkillPackageInput(tc.input, args...)
				if (err != nil) != (tc.failure != "") || err != nil && !strings.Contains(err.Error(), tc.failure) {
					t.Fatalf("%v %s %s", err, out, stderr)
				}
				writes := 0
				for _, r := range calls() {
					if r.method != "GET" {
						writes++
					}
				}
				if writes != 0 && !tc.write || writes != 1 && tc.write {
					t.Fatalf("writes %d", writes)
				}
				if strings.Contains(tc.name, "abort") && (!strings.Contains(stderr, "Aborted.") || out != "") {
					t.Fatalf("%q %q", out, stderr)
				}
				if strings.Contains(tc.name, "interactive") || tc.name == "no input" {
					for _, want := range []string{"package", "1 managed skills", "1 agent bindings", "[y/N]"} {
						if !strings.Contains(stderr, want) {
							t.Fatal(stderr)
						}
					}
				}
				if strings.Contains(tc.name, "dry run") && !strings.Contains(stderr, "Read-only preview") {
					t.Fatal(stderr)
				}
				if tc.name == "cannot delete" && (strings.Contains(stderr, "[y/N]") || len(calls()) != 1) {
					t.Fatalf("prompt on refusal %s %+v", stderr, calls())
				}
				if out != "" && output == "json" {
					var document map[string]any
					if json.Unmarshal([]byte(out), &document) != nil {
						t.Fatal(out)
					}
				}
				if out != "" && output == "table" && !tc.write && (!strings.Contains(out, "Reviewer") || !strings.Contains(out, "alpha") || !strings.Contains(out, "signed-delete")) {
					t.Fatal(out)
				}
			})
		}
	}
}

func TestLabrastroSkillPackageRemovalRejectsMalformedAndDoesNotRetry(t *testing.T) {
	for _, action := range []string{"delete", "dissolve"} {
		for _, mode := range []string{"missing token", "null ids", "invalid id", "duplicate ids", "invalid agent", "missing permission", "malformed result", "wrong count", "403", "409", "500"} {
			t.Run(action+mode, func(t *testing.T) {
				preview := skillRemovalPreviewFixture()
				badPreview := true
				switch mode {
				case "missing token":
					delete(preview, "preview_id")
				case "null ids":
					preview["skill_ids"] = nil
				case "invalid id":
					preview["skill_ids"] = []any{"bad"}
				case "duplicate ids":
					preview["skill_ids"] = []any{migrationSkillID, migrationSkillID}
				case "invalid agent":
					preview["affected_agents"] = []any{map[string]any{"id": manageRoot}}
				case "missing permission":
					delete(preview, "can_delete")
				default:
					badPreview = false
				}
				calls := serveSkillFolder(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
					var result any = preview
					if r.Method != "GET" {
						switch mode {
						case "malformed result":
							result = map[string]any{"deleted": true}
						case "wrong count":
							result = map[string]any{"deleted": action == "delete", "dissolved": action == "dissolve", "skill_count": 0}
						default:
							status := 500
							fmt.Sscan(mode, &status)
							w.WriteHeader(status)
							result = map[string]any{"error": "refused", "code": "preview_stale"}
						}
					}
					_ = json.NewEncoder(w).Encode(result)
				})
				args := []string{action, skillPackageTestID}
				if action == "delete" {
					args = append(args, "--yes")
				}
				out, _, err := executeSkillPackageInput("", args...)
				if err == nil {
					t.Fatal("accepted malformed/refused response")
				}
				want := 2
				if badPreview {
					want = 1
				}
				if len(calls()) != want {
					t.Fatalf("retried or wrote without valid preview: %+v", calls())
				}
				if mode == "403" || mode == "409" || mode == "500" {
					assertSkillPackageJSON(t, out, map[string]any{"error": "refused", "code": "preview_stale"})
				}
			})
		}
	}
}

type delayedSkillPackageConfirmation struct{}

func (delayedSkillPackageConfirmation) Read(p []byte) (int, error) {
	time.Sleep(2 * time.Minute)
	return copy(p, "yes\n"), io.EOF
}

func TestLabrastroSkillPackageDeleteTimeoutStartsAfterConfirmation(t *testing.T) {
	pkg := skillPackageFixture(t, "apply")["package"]
	synctest.Test(t, func(t *testing.T) {
		cmd, _, err := newSkillPackageCmd().Find([]string{"delete"})
		if err != nil {
			t.Fatal(err)
		}
		cmd.SetContext(context.Background())
		cmd.SetIn(delayedSkillPackageConfirmation{})
		var out, stderr bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetErr(&stderr)
		client := cli.NewAPIClient("http://test.invalid", migrationTargetWS, "mat_offline_test")
		client.AgentID, client.TaskID = manageRoot, manageOther
		writes := 0
		client.HTTPClient.Transport = skillPackageRoundTripper(func(r *http.Request) (*http.Response, error) {
			var response any = pkg
			if strings.HasSuffix(r.URL.Path, "/delete-preview") {
				response = skillRemovalPreviewFixture()
			}
			if r.Method == "DELETE" {
				writes++
				deadline, ok := r.Context().Deadline()
				if r.Context().Err() != nil || !ok || time.Until(deadline) <= 0 {
					t.Error("prompt consumed write timeout")
				}
				if r.Header.Get("X-Agent-ID") != manageRoot || r.Header.Get("X-Task-ID") != manageOther || r.Header.Get("X-Workspace-ID") != migrationTargetWS || r.Header.Get("Authorization") != "Bearer mat_offline_test" || r.Header.Get("X-Client-Version") == "" {
					t.Error("delete lost API client headers")
				}
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["preview_id"] != "signed-delete" {
					t.Errorf("delete lost preview body: %+v", body)
				}
				response = map[string]any{"deleted": true, "dissolved": false, "skill_count": 1}
			}
			data, _ := json.Marshal(response)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(data))}, nil
		})
		if err := runSkillPackageRemoval(cmd, client, "/api/skill-packages/"+skillPackageTestID); err != nil {
			t.Fatal(err)
		}
		if writes != 1 {
			t.Fatalf("writes=%d", writes)
		}
	})
}
