package handler

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
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

func TestUploadFileRejectsMixedAttachmentOwners(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	issue := dbfx.Issue(t, "mixed owner target")

	store := &recordingStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })

	uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
		"baseline_page_id": page.Page.ID,
		"issue_id":         issue,
	}).Want(http.StatusBadRequest)

	if len(store.files) != 0 || len(store.deleted) != 0 {
		t.Fatalf("rejected mixed upload touched storage: files=%v deleted=%v", store.files, store.deleted)
	}
}

func TestBaselinePageAttachmentIsNotClaimedByIssueOrComment(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	issue := dbfx.Issue(t, "claim target")
	comment := dbfx.Comment(t, issue, "claim comment")

	store := &mockStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "DELETE FROM attachment WHERE baseline_page_id = $1", page.Page.ID)
	})

	var uploaded AttachmentResponse
	uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
		"baseline_page_id": page.Page.ID,
	}).Want(200).JSON(&uploaded)
	attachmentID := parseUUID(uploaded.ID)

	linked, err := testHandler.Queries.LinkAttachmentsToIssue(context.Background(), db.LinkAttachmentsToIssueParams{
		IssueID: parseUUID(issue), WorkspaceID: parseUUID(testWorkspaceID),
		AttachmentIds: []pgtype.UUID{attachmentID}, BumpRevision: true,
	})
	if err != nil || linked.LinkedCount != 0 {
		t.Fatalf("issue claim = (%+v, %v), want no link", linked, err)
	}
	if err := testHandler.Queries.LinkAttachmentsToComment(context.Background(), db.LinkAttachmentsToCommentParams{
		CommentID: parseUUID(comment), IssueID: parseUUID(issue), WorkspaceID: parseUUID(testWorkspaceID),
		AttachmentIds: []pgtype.UUID{attachmentID},
	}); err != nil {
		t.Fatal(err)
	}
	locked, err := testHandler.Queries.LockUnboundAttachmentsForCommentLink(context.Background(), db.LockUnboundAttachmentsForCommentLinkParams{
		WorkspaceID: parseUUID(testWorkspaceID), AttachmentIds: []pgtype.UUID{attachmentID},
	})
	if err != nil || len(locked) != 0 {
		t.Fatalf("comment lock = (%v, %v), want none", locked, err)
	}
	lockedForIssue, err := testHandler.Queries.LockAttachmentsForIssueLink(context.Background(), db.LockAttachmentsForIssueLinkParams{
		WorkspaceID: parseUUID(testWorkspaceID), AttachmentIds: []pgtype.UUID{attachmentID},
	})
	if err != nil || len(lockedForIssue) != 0 {
		t.Fatalf("issue lock = (%v, %v), want none", lockedForIssue, err)
	}
	linkedChat, err := testHandler.Queries.LinkAttachmentsToChatMessage(context.Background(), db.LinkAttachmentsToChatMessageParams{
		ChatMessageID: parseUUID(uuid.NewString()), ChatSessionID: parseUUID(uuid.NewString()),
		WorkspaceID: parseUUID(testWorkspaceID), UploaderType: "member", UploaderID: parseUUID(testUserID),
		AttachmentIds: []pgtype.UUID{attachmentID},
	})
	if err != nil || len(linkedChat) != 0 {
		t.Fatalf("chat claim = (%v, %v), want none", linkedChat, err)
	}
	bound, err := testHandler.Queries.BindChatAttachmentsToMessage(context.Background(), db.BindChatAttachmentsToMessageParams{
		ChatMessageID: parseUUID(uuid.NewString()), WorkspaceID: parseUUID(testWorkspaceID),
		TaskID: parseUUID(uuid.NewString()),
	})
	if err != nil || len(bound) != 0 {
		t.Fatalf("chat task bind = (%v, %v), want none", bound, err)
	}
	if _, err := testHandler.Queries.ReplaceCommentAttachments(context.Background(), db.ReplaceCommentAttachmentsParams{
		CommentID: parseUUID(comment), IssueID: parseUUID(issue), AttachmentIds: []pgtype.UUID{attachmentID},
	}); err != nil {
		t.Fatal(err)
	}
	stored, err := testHandler.Queries.GetAttachment(context.Background(), db.GetAttachmentParams{
		ID: attachmentID, WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if stored.IssueID.Valid || stored.CommentID.Valid || uuidToString(stored.BaselinePageID) != page.Page.ID {
		t.Fatalf("page attachment was claimed: issue=%v comment=%v page=%s", stored.IssueID.Valid, stored.CommentID.Valid, uuidToString(stored.BaselinePageID))
	}
}

func TestPrivateProjectHidesMixedPageAttachment(t *testing.T) {
	f := newPrivateProjectFixture(t)
	var pageID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO project_baseline_page (workspace_id, project_id, title, slug, position, current_revision_id, last_revision_number)
		VALUES ($1, $2, 'secret canvas', $3, 0, gen_random_uuid(), 0)
		RETURNING id::text
	`, testWorkspaceID, f.projectID, "secret-canvas-"+uuid.NewString()[:8]).Scan(&pageID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "DELETE FROM attachment WHERE baseline_page_id = $1", pageID)
		testPool.Exec(context.Background(), "DELETE FROM project_baseline_page WHERE id = $1", pageID)
	})

	store := &mockStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })

	body := []byte("<html><body>secret canvas</body></html>")
	url, err := store.Upload(context.Background(), "secret-canvas.html", body, "text/html", "secret.html")
	if err != nil {
		t.Fatal(err)
	}
	var attachmentID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO attachment (workspace_id, issue_id, baseline_page_id, uploader_type, uploader_id, filename, url, content_type, size_bytes)
		VALUES ($1, $2, $3, 'member', $4, 'secret.html', $5, 'text/html', $6)
		RETURNING id::text
	`, testWorkspaceID, f.publicIssue, pageID, testUserID, url, len(body)).Scan(&attachmentID); err != nil {
		t.Fatal(err)
	}

	read := func(userID string) *testutil.Response {
		req, _ := newPreviewRequest(t, attachmentID, testWorkspaceID)
		req.Header.Set("X-User-ID", userID)
		return testutil.Call(t, testHandler.GetAttachmentContent, req)
	}
	// The row also carries a visible issue; the hidden page owner must win.
	read(f.outsider).Want(http.StatusNotFound)
	read(f.insider).Want(http.StatusOK)
}

func TestBaselineAttachmentUploadRevalidatesPageUnderLock(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")

	store := &recordingStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "DELETE FROM attachment WHERE baseline_page_id = $1", page.Page.ID)
	})

	// Hold the project lock exactly like DeleteProject does, delete the page,
	// then commit. The upload's first pre-check already saw the page, so only
	// the in-transaction revalidation can reject it.
	tx, err := testPool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	qtx := testHandler.Queries.WithTx(tx)
	if _, err := qtx.LabrastroLockEngineeringProject(context.Background(), db.LabrastroLockEngineeringProjectParams{
		WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(f.project),
	}); err != nil {
		t.Fatal(err)
	}

	done := make(chan *testutil.Response, 1)
	go func() {
		done <- uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
			"baseline_page_id": page.Page.ID,
		})
	}()
	select {
	case res := <-done:
		t.Fatalf("upload did not wait for the project lock: %+v", res)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := tx.Exec(context.Background(), "DELETE FROM project_baseline_page WHERE id = $1", page.Page.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		res.Want(http.StatusForbidden)
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish after the page lock was released")
	}
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || len(store.deleted) != 1 {
		t.Fatalf("rejected upload left rows=%d cleanup=%v", count, store.deleted)
	}
}

func TestDeleteProjectRemovesBaselineAttachmentObjects(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")

	store := &recordingStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })

	uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
		"baseline_page_id": page.Page.ID,
	}).Want(200)
	if len(store.files) != 1 {
		t.Fatalf("seed storage = %v", store.files)
	}

	testutil.Call(t, testHandler.DeleteProject, f.request("admin", "DELETE", "", nil, nil)).Want(http.StatusNoContent)
	if len(store.deleted) != 1 {
		t.Fatalf("project delete cleanup = %v", store.deleted)
	}
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("project delete left %d attachment rows", count)
	}
}
