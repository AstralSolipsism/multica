package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeBaselineArchive prepares a content file plus a canvas artifact in a
// fresh working directory (the CLI only accepts files inside it).
func writeBaselineArchive(t *testing.T) (contentFile, canvasFile string) {
	t.Helper()
	t.Chdir(t.TempDir())
	if err := os.WriteFile("content.md", []byte("## 架构\n\n```html src=\"architecture.html\" title=\"架构画布\"\n交互画布见附件。\n```\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("architecture.html", []byte("<!doctype html><html><body>canvas</body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	return "content.md", "architecture.html"
}

func baselineUploadAttachmentResponse() map[string]any {
	return map[string]any{
		"id":           "50000000-0000-4000-8000-000000000001",
		"filename":     "architecture.html",
		"content_type": "text/html",
		"size_bytes":   49,
		"created_at":   "2026-11-01T00:00:00Z",
	}
}

func TestLabrastroBaselineWriteUploadsAttachments(t *testing.T) {
	contentFile, canvasFile := writeBaselineArchive(t)
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		switch {
		case r.Method == "PUT" && strings.HasSuffix(r.URL.Path, "/baseline/pages/architecture/content"):
			if body["content_markdown"] == nil || body["base_revision_number"] != float64(1) {
				t.Errorf("write body: %+v", body)
			}
			baselineWriteJSON(w, 200, baselineWikiWriteResult("architecture", "架构", 2, "content", "", false))
		case r.Method == "POST" && r.URL.Path == "/api/upload-file":
			baselineWriteJSON(w, 200, baselineUploadAttachmentResponse())
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})

	out, stderr, code := executeBaseline(t, "write", baselineTestProject, "--page", "architecture", "--base", "1",
		"--content-file", contentFile, "--attachment", canvasFile)
	if code != 0 || stderr != "" {
		t.Fatalf("write: %d out=%q stderr=%q", code, out, stderr)
	}
	for _, want := range []string{"written: architecture v2", "attachment: architecture.html (49 bytes)"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q: %s", want, out)
		}
	}

	recorded := calls()
	if len(recorded) != 2 {
		t.Fatalf("calls = %+v", recorded)
	}
	upload := recorded[1]
	if upload.Path != "/api/upload-file" {
		t.Fatalf("upload path = %s", upload.Path)
	}
	if upload.Fields["baseline_page_id"] != baselineTestPageID || upload.Fields["baseline_revision_id"] != baselineTestRevisionID {
		t.Fatalf("upload binding = %+v", upload.Fields)
	}
	if upload.Fields["file"] != "architecture.html" {
		t.Fatalf("uploaded filename = %q", upload.Fields["file"])
	}
}

func TestLabrastroBaselineWriteAttachmentUploadFailureKeepsRevision(t *testing.T) {
	contentFile, canvasFile := writeBaselineArchive(t)
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case r.Method == "PUT":
			baselineWriteJSON(w, 200, baselineWikiWriteResult("architecture", "架构", 2, "content", "", false))
		case r.Method == "POST" && r.URL.Path == "/api/upload-file":
			baselineWriteJSON(w, 403, map[string]any{"error": "invalid baseline_page_id"})
		}
	})

	out, stderr, code := executeBaseline(t, "write", baselineTestProject, "--page", "architecture", "--base", "1",
		"--content-file", contentFile, "--attachment", canvasFile)
	if code != 1 {
		t.Fatalf("exit = %d, out=%q stderr=%q", code, out, stderr)
	}
	if !strings.Contains(out, "written: architecture v2") || !strings.Contains(stderr, "architecture v2 written") || !strings.Contains(stderr, "HTTP 403") {
		t.Fatalf("out=%q stderr=%q", out, stderr)
	}
	if len(calls()) != 2 {
		t.Fatalf("calls = %+v", calls())
	}
}

func TestLabrastroBaselineWriteRejectsAttachmentOutsideWorkdir(t *testing.T) {
	contentFile, _ := writeBaselineArchive(t)
	outside := filepath.Join(t.TempDir(), "outside.html")
	if err := os.WriteFile(outside, []byte("<html></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, calls := serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		t.Error("invalid attachment reached the server")
		w.WriteHeader(500)
	})

	out, stderr, code := executeBaseline(t, "write", baselineTestProject, "--page", "architecture", "--base", "1",
		"--content-file", contentFile, "--attachment", outside)
	if code != 2 || out != "" || !strings.Contains(stderr, "inside the current directory") {
		t.Fatalf("exit=%d out=%q stderr=%q", code, out, stderr)
	}
	if len(calls()) != 0 {
		t.Fatalf("write committed before local attachment validation: %+v", calls())
	}
}
