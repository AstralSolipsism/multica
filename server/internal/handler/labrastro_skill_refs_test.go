package handler

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestLabrastroReferenceClosure(t *testing.T) {
	files := map[string]string{
		"skills/demo/SKILL.md":  "---\nname: demo\n---\n[guide](../../references/guide.md#start)\n`../../references/guide.md`\n`../project-feature-a`\n[remote](https://example.com/file.md)\n```md\n`../../references/example.md`\n```\n",
		"skills/demo/local.md":  "local text",
		"references/guide.md":   "[back](../skills/demo/local.md) [again](nested.md#next)\n[defs][x]\n[x]: nested.md#next\n",
		"references/nested.md":  "[cycle](guide.md) [main](../skills/demo/SKILL.md)\n[other](../skills/other/SKILL.md) `../secret` `../LICENSE`",
		"references/example.md": "fenced example must not be fetched",
		"skills/other/SKILL.md": "other skill",
		"secret":                "symlink target",
		"LICENSE":               "license",
	}
	r := &importedSkill{content: files["skills/demo/SKILL.md"], files: []importedFile{{"local.md", files["skills/demo/local.md"]}}}
	counts := map[string]int{}
	lookup := func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		_, ok := files[p]
		mode := "100644"
		if p == "secret" {
			mode = "120000"
		}
		return githubTreeEntry{Path: p, Type: "blob", Mode: mode}, ok, nil
	}
	err := labrastroCompleteReferences(t.Context(), r, "skills/demo", lookup, func(_ context.Context, p string) ([]byte, error) { counts[p]++; return []byte(files[p]), nil })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.content, "[guide](_shared/references/guide.md#start)") || !strings.Contains(r.content, "`../project-feature-a`") || !strings.Contains(r.content, "`../../references/example.md`") {
		t.Fatalf("unexpected primary rewrite: %s", r.content)
	}
	got := map[string]string{}
	for _, f := range r.files {
		got[f.path] = f.content
	}
	if !strings.Contains(got["_shared/references/guide.md"], "[back](../../local.md)") || !strings.Contains(got["_shared/references/nested.md"], "[main](../../SKILL.md)") {
		t.Fatalf("back references are wrong: %#v", got)
	}
	if len(got) != 3 || counts["references/guide.md"] != 1 || counts["references/nested.md"] != 1 || counts["references/example.md"] != 0 {
		t.Fatalf("closure was not bounded/deduplicated: files=%v fetches=%v", got, counts)
	}
	codes := map[string]bool{}
	for _, d := range r.diagnostics {
		codes[d.Code] = true
	}
	if !codes["cross_skill_reference"] || !codes["filtered_reference"] {
		t.Fatalf("missing diagnostics: %+v", r.diagnostics)
	}
}

func TestLabrastroReferenceFailures(t *testing.T) {
	for _, tc := range []struct {
		name, code  string
		size        int64
		files       []importedFile
		downloadErr error
	}{
		{"required download", "required_reference_unavailable", 1, nil, errors.New("HTTP 503")},
		{"shared collision", "shared_path_conflict", 1, []importedFile{{"_shared/references/a.md", "different"}}, nil},
		{"file limit", "limit_exceeded", maxImportFileSize + 1, nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &importedSkill{content: "[a](../../references/a.md)", files: tc.files}
			err := labrastroCompleteReferences(t.Context(), r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
				return githubTreeEntry{Path: p, Type: "blob", Mode: "100644", Size: tc.size}, true, nil
			}, func(context.Context, string) ([]byte, error) { return []byte("shared"), tc.downloadErr })
			var detail *labrastroImportError
			if !errors.As(err, &detail) || detail.Diagnostic.Code != tc.code {
				t.Fatalf("got %v, want %s", err, tc.code)
			}
		})
	}
}

func TestLabrastroReferenceFinalByteBudget(t *testing.T) {
	r := &importedSkill{content: "[a](../../references/a.md)"}
	for i := 0; i < 8; i++ {
		r.files = append(r.files, importedFile{fmt.Sprintf("%d.txt", i), strings.Repeat("a", maxImportFileSize)})
	}
	err := labrastroCompleteReferences(t.Context(), r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		return githubTreeEntry{Path: p, Type: "blob", Size: 1}, true, nil
	}, func(context.Context, string) ([]byte, error) { return []byte("a"), nil })
	if !isCapError(err) {
		t.Fatalf("want aggregate cap error, got %v", err)
	}
}

func TestLabrastroPreviewSignatures(t *testing.T) {
	token := labrastroSignPreview("one", time.Now().Unix()+100)
	if !labrastroValidatePreview(token, "one") || labrastroValidatePreview(token, "two") || labrastroValidatePreview(labrastroSignPreview("one", 1), "one") || labrastroValidatePreview(token+"x", "one") {
		t.Fatal("preview signature or expiry validation failed")
	}
}

func TestLabrastroReferenceCodeContainersAndEscapedPaths(t *testing.T) {
	body := "> ```md\n> [example](../../references/example.md)\n> ```\n\n- ```md\n  [example](../../references/example.md)\n  ```\n\n[space](../../references/a\\ b.md#anchor)\n"
	r := &importedSkill{content: body}
	fetched := []string{}
	err := labrastroCompleteReferences(t.Context(), r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		return githubTreeEntry{Path: p, Type: "blob", Mode: "100644"}, true, nil
	}, func(_ context.Context, p string) ([]byte, error) {
		fetched = append(fetched, p)
		return []byte("text"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched) != 1 || fetched[0] != "references/a b.md" || !strings.Contains(r.content, "[space](_shared/references/a%20b.md#anchor)") || strings.Count(r.content, "../../references/example.md") != 2 {
		t.Fatalf("code examples or escaped path were rewritten incorrectly: fetches=%v body=%s", fetched, r.content)
	}
}
