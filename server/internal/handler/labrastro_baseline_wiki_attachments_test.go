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

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	return uploadBaselineAttachmentAs(t, testUserID, filename, data, fields)
}

func uploadBaselineAttachmentAs(t *testing.T, userID, filename string, data []byte, fields map[string]string) *testutil.Response {
	t.Helper()
	return uploadBaselineAttachmentWithHeaders(t, filename, data, fields, map[string]string{
		"X-User-ID":      userID,
		"X-Workspace-ID": testWorkspaceID,
	})
}

func uploadBaselineAttachmentWithHeaders(t *testing.T, filename string, data []byte, fields, headers map[string]string) *testutil.Response {
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
	for name, value := range headers {
		req.Header.Set(name, value)
	}
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

// cleanupStorage deletes stored bytes on DeleteKeys, so tests can assert both
// the cleanup request and that no object survives a refused upload.
type cleanupStorage struct {
	mockStorage
	deleted int
}

func (s *cleanupStorage) DeleteKeys(ctx context.Context, keys []string) {
	s.deleted += len(keys)
	for _, key := range keys {
		s.mockStorage.Delete(ctx, key)
	}
}

// holdProjectLockAndRevoke starts an upload that will pass its pre-check and
// storage phase, then blocks on the project row. revoke runs in that window;
// the returned upload result arrives after the lock transaction commits.
func holdProjectLockAndRevoke(t *testing.T, projectID string, upload func() *testutil.Response, revoke func(ctx context.Context, tx pgx.Tx)) *testutil.Response {
	t.Helper()
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	qtx := testHandler.Queries.WithTx(tx)
	if _, err := qtx.LabrastroLockEngineeringProject(ctx, db.LabrastroLockEngineeringProjectParams{
		WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(projectID),
	}); err != nil {
		t.Fatal(err)
	}
	done := make(chan *testutil.Response, 1)
	go func() { done <- upload() }()
	select {
	case res := <-done:
		t.Fatalf("upload did not wait for the project lock: %+v", res)
	case <-time.After(300 * time.Millisecond):
	}
	revoke(ctx, tx)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		return res
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish after the lock was released")
		return nil
	}
}

func TestBaselineAttachmentUploadRejectsRevokedProjectAccess(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	store := &cleanupStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "UPDATE project SET visibility = 'public' WHERE id = $1", f.project)
	})

	res := holdProjectLockAndRevoke(t, f.project, func() *testutil.Response {
		return uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
			"baseline_page_id": page.Page.ID,
		})
	}, func(ctx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(ctx, "UPDATE project SET visibility = 'private' WHERE id = $1", f.project); err != nil {
			t.Fatal(err)
		}
	})
	res.Want(http.StatusForbidden)
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || len(store.files) != 0 || store.deleted != 1 {
		t.Fatalf("revoked project access left rows=%d files=%v deleted=%d", count, store.files, store.deleted)
	}
}

func TestBaselineAttachmentUploadRejectsRevokedMembership(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	uploader := createPlainMember(t, uuid.NewString()+"-uploader@multica.test")
	store := &cleanupStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })

	// The member delete holds the row lock and is uncommitted while the bytes
	// upload; the upload's shared member lock then waits, and the committed
	// delete makes the revalidation see no membership.
	tx, err := testPool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), "DELETE FROM member WHERE workspace_id = $1 AND user_id = $2", testWorkspaceID, uploader); err != nil {
		t.Fatal(err)
	}

	done := make(chan *testutil.Response, 1)
	go func() {
		done <- uploadBaselineAttachmentAs(t, uploader, "architecture.html", []byte("<html></html>"), map[string]string{
			"baseline_page_id": page.Page.ID,
		})
	}()
	select {
	case res := <-done:
		t.Fatalf("upload did not wait for the member lock: %+v", res)
	case <-time.After(300 * time.Millisecond):
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		res.Want(http.StatusForbidden)
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish after the member deletion committed")
	}
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || len(store.files) != 0 || store.deleted != 1 {
		t.Fatalf("revoked membership left rows=%d files=%v deleted=%d", count, store.files, store.deleted)
	}
}

func TestBaselineAttachmentUploadRejectsArchivedPageDuringUpload(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	store := &cleanupStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })

	res := holdProjectLockAndRevoke(t, f.project, func() *testutil.Response {
		return uploadBaselineAttachment(t, "architecture.html", []byte("<html></html>"), map[string]string{
			"baseline_page_id": page.Page.ID,
		})
	}, func(ctx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(ctx, "UPDATE project_baseline_page SET archived_at = now() WHERE id = $1", page.Page.ID); err != nil {
			t.Fatal(err)
		}
	})
	res.Want(http.StatusForbidden)
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || len(store.files) != 0 || store.deleted != 1 {
		t.Fatalf("archived page upload left rows=%d files=%v deleted=%d", count, store.files, store.deleted)
	}
}

func TestBaselineAttachmentUploadRejectsAgentOwnerWithoutAccess(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	agent := dbfx.Agent(t, "baseline-agent-"+uuid.NewString(), testRuntimeID, testutil.Cols{"owner_id": f.memberUser})
	task := dbfx.Task(t, agent, testutil.Cols{
		"runtime_id":          testRuntimeID,
		"originator_user_id":  f.adminUser,
		"accountable_user_id": f.adminUser,
		"originator_source":   "member",
	})
	store := &cleanupStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "UPDATE project SET visibility = 'public' WHERE id = $1", f.project)
	})

	// The project is public while the bytes upload; the originator keeps
	// access and the agent owner is excluded only afterwards.
	res := holdProjectLockAndRevoke(t, f.project, func() *testutil.Response {
		return uploadBaselineAttachmentWithHeaders(t, "architecture.html", []byte("<html></html>"), map[string]string{
			"baseline_page_id": page.Page.ID,
		}, map[string]string{
			"X-User-ID":      f.adminUser,
			"X-Workspace-ID": testWorkspaceID,
			"X-Actor-Source": "task_token",
			"X-Agent-ID":     agent,
			"X-Task-ID":      task,
		})
	}, func(ctx context.Context, tx pgx.Tx) {
		if _, err := tx.Exec(ctx, "UPDATE project SET visibility = 'private' WHERE id = $1", f.project); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO project_member (workspace_id, project_id, user_id, added_by)
			VALUES ($1, $2, $3, $3)
		`, testWorkspaceID, f.project, f.adminUser); err != nil {
			t.Fatal(err)
		}
	})

	res.Want(http.StatusForbidden)
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || len(store.files) != 0 || store.deleted != 1 {
		t.Fatalf("excluded agent owner left rows=%d files=%v deleted=%d", count, store.files, store.deleted)
	}
}

func TestBaselineAttachmentUploadHoldsMemberLockUntilCommit(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	page := f.create("session", "架构", "architecture", nil, nil, "## 架构\n")
	uploader := createPlainMember(t, uuid.NewString()+"-lock-uploader@multica.test")
	member, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(), db.GetMemberByUserAndWorkspaceParams{
		UserID: parseUUID(uploader), WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &cleanupStorage{}
	originalStorage, originalSigner := testHandler.Storage, testHandler.CFSigner
	testHandler.Storage, testHandler.CFSigner = store, nil
	t.Cleanup(func() { testHandler.Storage, testHandler.CFSigner = originalStorage, originalSigner })
	t.Cleanup(func() {
		testPool.Exec(context.Background(), "DELETE FROM attachment WHERE baseline_page_id = $1", page.Page.ID)
	})

	// Hold the project row so the upload pauses AFTER taking the shared member
	// lock. Member deletion then has to wait for the upload's commit.
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
	uploadDone := make(chan *testutil.Response, 1)
	go func() {
		uploadDone <- uploadBaselineAttachmentAs(t, uploader, "architecture.html", []byte("<html></html>"), map[string]string{
			"baseline_page_id": page.Page.ID,
		})
	}()
	select {
	case res := <-uploadDone:
		t.Fatalf("upload did not pause on the project lock: %+v", res)
	case <-time.After(300 * time.Millisecond):
	}

	deleteDone := make(chan *testutil.Response, 1)
	go func() {
		req := newRequest(http.MethodDelete, "/api/workspaces/"+testWorkspaceID+"/members/"+uuidToString(member.ID), nil)
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		req.Header.Set("X-User-ID", f.adminUser)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", testWorkspaceID)
		rctx.URLParams.Add("memberId", uuidToString(member.ID))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		deleteDone <- testutil.Call(t, testHandler.DeleteMember, req)
	}()
	select {
	case res := <-deleteDone:
		t.Fatalf("member deletion completed before the upload committed: %+v", res)
	case <-time.After(300 * time.Millisecond):
	}

	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-uploadDone:
		res.Want(http.StatusOK)
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish after the project lock was released")
	}
	select {
	case res := <-deleteDone:
		res.Want(http.StatusNoContent)
	case <-time.After(5 * time.Second):
		t.Fatal("member deletion did not finish after the upload committed")
	}
	var attachments int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM attachment WHERE baseline_page_id = $1", page.Page.ID).Scan(&attachments); err != nil {
		t.Fatal(err)
	}
	if attachments != 1 {
		t.Fatalf("uploaded attachment rows = %d, want 1", attachments)
	}
}
