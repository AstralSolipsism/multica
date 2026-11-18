package handler

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type baselineWikiAttachmentsOut struct {
	Page struct {
		ID string `json:"id"`
	} `json:"page"`
	Revision struct {
		ID string `json:"id"`
	} `json:"revision"`
	Attachments []struct {
		ID          string `json:"id"`
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		SizeBytes   int64  `json:"size_bytes"`
	} `json:"attachments"`
}

func uploadBaselineAttachment(t *testing.T, filename string, data []byte, fields map[string]string) *testutil.Response {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/upload-file", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-User-ID", testUserID)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)
	return testutil.Call(t, testHandler.UploadFile, req)
}

func TestBaselineWikiPageAttachmentReadAndUpload(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n\n```html src=\"architecture.html\"\n交互画布见附件。\n```\n")

	store := &mockStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "DELETE FROM attachment WHERE baseline_page_id = $1", page.Page.ID)
	})

	canvas := []byte("<!doctype html><html><body>canvas</body></html>")
	var uploaded AttachmentResponse
	uploadBaselineAttachment(t, "architecture.html", canvas, map[string]string{
		"baseline_page_id":     page.Page.ID,
		"baseline_revision_id": page.Revision.ID,
	}).Want(200).JSON(&uploaded)
	if uploaded.Filename != "architecture.html" || !strings.HasPrefix(uploaded.ContentType, "text/html") {
		t.Fatalf("uploaded = %+v", uploaded)
	}

	stored, err := testHandler.Queries.GetAttachment(context.Background(), db.GetAttachmentParams{
		ID: parseUUID(uploaded.ID), WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if uuidToString(stored.BaselinePageID) != page.Page.ID || uuidToString(stored.BaselineRevisionID) != page.Revision.ID {
		t.Fatalf("binding = page %s revision %s", uuidToString(stored.BaselinePageID), uuidToString(stored.BaselineRevisionID))
	}

	var read baselineWikiAttachmentsOut
	testutil.Call(t, testHandler.LabrastroReadWikiPage, f.request("session", "GET", "/baseline/pages/architecture", nil, map[string]string{"page": "architecture"})).Want(200).JSON(&read)
	if len(read.Attachments) != 1 || read.Attachments[0].ID != uploaded.ID || read.Attachments[0].Filename != "architecture.html" || read.Attachments[0].SizeBytes != int64(len(canvas)) {
		t.Fatalf("page attachments = %+v", read.Attachments)
	}
}

func TestBaselineWikiAttachmentUploadRejectsForeignOwners(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	first := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	second := f.create("session", "另一页", "other", nil, nil, "## 另一页\n")

	store := &mockStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "DELETE FROM attachment WHERE baseline_page_id = ANY($1::uuid[])",
			[]string{first.Page.ID, second.Page.ID})
	})

	// A revision of another page must not be attached to this one.
	uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
		"baseline_page_id":     first.Page.ID,
		"baseline_revision_id": second.Revision.ID,
	}).Want(http.StatusForbidden)

	// A revision id without a page has no owner to validate against.
	uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
		"baseline_revision_id": first.Revision.ID,
	}).Want(http.StatusBadRequest)

	// An unknown page id is rejected before anything is stored.
	uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
		"baseline_page_id": "00000000-0000-4000-8000-000000000000",
	}).Want(http.StatusForbidden)

	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", first.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rejected uploads left %d attachment rows", count)
	}
}
