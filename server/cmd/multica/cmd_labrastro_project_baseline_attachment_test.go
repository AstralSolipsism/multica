package main

import (
	"encoding/json"
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
	if code != 0 {
		t.Fatalf("write: %d out=%q stderr=%q", code, out, stderr)
	}
	if !strings.Contains(out, "written: architecture v2") {
		t.Fatalf("stdout missing write result: %s", out)
	}
	if !strings.Contains(stderr, "attachment: architecture.html (49 bytes)") {
		t.Fatalf("stderr missing attachment result: %s", stderr)
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
	if !strings.Contains(out, "written: architecture v2") || !strings.Contains(stderr, "architecture v2 written") || !strings.Contains(stderr, "upload failed") {
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

func attachmentUploaded(w http.ResponseWriter, r *http.Request) {
	filename := ""
	if r.MultipartForm != nil {
		if files := r.MultipartForm.File["file"]; len(files) > 0 {
			filename = files[0].Filename
		}
	}
	baselineWriteJSON(w, 200, map[string]any{
		"id":           "att-" + filename,
		"filename":     filename,
		"content_type": "text/html",
		"size_bytes":   49,
		"created_at":   "2026-11-01T00:00:00Z",
	})
}

func TestLabrastroBaselineWriteAttachmentsJSON(t *testing.T) {
	contentFile, canvasFile := writeBaselineArchive(t)
	if err := os.WriteFile("second.html", []byte("<html>second</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case r.Method == "PUT":
			baselineWriteJSON(w, 200, baselineWikiWriteResult("architecture", "架构", 2, "content", "", false))
		case r.Method == "POST" && r.URL.Path == "/api/upload-file":
			attachmentUploaded(w, r)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})

	out, stderr, code := executeBaseline(t, "write", baselineTestProject, "--page", "architecture", "--base", "1",
		"--content-file", contentFile, "--attachment", canvasFile, "--attachment", "second.html", "--output", "json")
	if code != 0 || stderr != "" {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	result := baselineJSON(t, out)
	attachments, ok := result["attachments"].([]any)
	if !ok || len(attachments) != 2 {
		t.Fatalf("attachments = %#v", result["attachments"])
	}
	first := attachments[0].(map[string]any)
	if first["id"] != "att-architecture.html" || first["filename"] != "architecture.html" {
		t.Fatalf("first attachment = %#v", first)
	}
	if result["page"].(map[string]any)["slug"] != "architecture" || result["revision"].(map[string]any)["revision_number"] != float64(2) {
		t.Fatalf("write fields lost: %#v", result)
	}
	if strings.Contains(out, "attachment: ") || !json.Valid([]byte(out)) {
		t.Fatalf("stdout is not one clean JSON object: %s", out)
	}
	if len(calls()) != 3 {
		t.Fatalf("calls = %+v", calls())
	}
}

func TestLabrastroBaselineWritePartialAttachmentFailureJSON(t *testing.T) {
	contentFile, canvasFile := writeBaselineArchive(t)
	if err := os.WriteFile("second.html", []byte("<html>second</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case r.Method == "PUT":
			baselineWriteJSON(w, 200, baselineWikiWriteResult("architecture", "架构", 2, "content", "", false))
		case r.Method == "POST" && r.URL.Path == "/api/upload-file":
			filename := ""
			if r.MultipartForm != nil {
				if files := r.MultipartForm.File["file"]; len(files) > 0 {
					filename = files[0].Filename
				}
			}
			if filename == "architecture.html" {
				baselineWriteJSON(w, 403, map[string]any{"error": "invalid baseline_page_id"})
				return
			}
			attachmentUploaded(w, r)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})

	out, stderr, code := executeBaseline(t, "write", baselineTestProject, "--page", "architecture", "--base", "1",
		"--content-file", contentFile, "--attachment", canvasFile, "--attachment", "second.html", "--output", "json")
	if code != 1 {
		t.Fatalf("exit=%d out=%q stderr=%q", code, out, stderr)
	}
	result := baselineJSON(t, out)
	attachments := result["attachments"].([]any)
	errorsList := result["attachment_errors"].([]any)
	if len(attachments) != 1 || len(errorsList) != 1 {
		t.Fatalf("result = %#v", result)
	}
	if errorsList[0].(map[string]any)["filename"] != "architecture.html" {
		t.Fatalf("attachment_errors = %#v", errorsList)
	}
	if !strings.Contains(stderr, "upload failed") || !strings.Contains(stderr, "1 of 2 attachments failed") {
		t.Fatalf("stderr = %q", stderr)
	}
}
