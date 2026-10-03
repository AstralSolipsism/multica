package handler

import (
	"strings"
	"testing"
)

func TestLabrastroLegacyImportAndRefreshExposeDiagnostics(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{
		"skills/demo/SKILL.md": "---\nname: demo\n---\n[shared](../../references/a.md)",
		"references/a.md":      "shared",
	})
	source.install(t)
	source.truncated = true
	url := source.url() + "/tree/main/skills/demo"
	var imported SkillWithFilesResponse
	labrastroCall(t, fx, testUserID, testHandler.ImportSkill, "POST", map[string]string{"url": url}).Want(201).JSON(&imported)
	if len(imported.Diagnostics) != 1 || imported.Diagnostics[0].Code != "tree_incomplete" {
		t.Fatalf("legacy import lost fallback diagnostic: %+v", imported.Diagnostics)
	}
	var refreshed SkillWithFilesResponse
	labrastroCall(t, fx, testUserID, testHandler.RefreshSkill, "POST", nil, "id", imported.ID).Want(200).JSON(&refreshed)
	if len(refreshed.Diagnostics) != 1 || refreshed.Diagnostics[0].Code != "tree_incomplete" {
		t.Fatalf("legacy refresh lost fallback diagnostic: %+v", refreshed.Diagnostics)
	}
	source.truncated = false
	source.failPath = "references/a.md"
	var failure struct {
		Error       string                  `json:"error"`
		Code        string                  `json:"code"`
		Diagnostics []SkillImportDiagnostic `json:"diagnostics"`
		Retryable   bool                    `json:"retryable"`
	}
	labrastroCall(t, fx, testUserID, testHandler.RefreshSkill, "POST", nil, "id", imported.ID).Want(502).JSON(&failure)
	if failure.Error == "" || failure.Code != "required_reference_unavailable" || !failure.Retryable || len(failure.Diagnostics) != 1 {
		t.Fatalf("legacy error contract lost diagnostics: %+v", failure)
	}
	var content string
	fx.QueryRow(t, "SELECT content FROM skill WHERE id=$1", imported.ID).Scan(&content)
	if content != imported.Content {
		t.Fatal("failed refresh modified saved content")
	}
}

func TestLabrastroArchiveRejectsSiblingSkills(t *testing.T) {
	data := buildTestZip(t, map[string]string{"repo/a/SKILL.md": testSkillMd, "repo/b/SKILL.md": testSkillMd})
	if _, err := parseSkillArchive(data, "skills.zip"); err == nil || !strings.Contains(err.Error(), "skill package import") {
		t.Fatalf("multiple sibling skills were not rejected with package guidance: %v", err)
	}
	data = buildTestZip(t, map[string]string{"repo/SKILL.md": testSkillMd, "repo/nested/SKILL.md": testSkillMd})
	if _, err := parseSkillArchive(data, "skill.zip"); err != nil {
		t.Fatalf("nested SKILL.md changed the existing root behavior: %v", err)
	}
}
