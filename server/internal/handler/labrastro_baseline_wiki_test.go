package handler

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// ---------- fixture ----------

type baselineWikiFixture struct {
	t                     *testing.T
	project, agent, task  string
	adminUser, memberUser string
}

func newBaselineWikiFixture(t *testing.T) baselineWikiFixture {
	t.Helper()
	f := baselineWikiFixture{t: t, project: dbfx.Project(t, "Baseline wiki")}
	f.agent = dbfx.Agent(t, "Baseline wiki agent "+uuid.NewString(), testRuntimeID)
	f.task = dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": testRuntimeID})
	f.adminUser = dbfx.User(t, "Baseline wiki admin", "baseline-wiki-admin-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, testWorkspaceID, f.adminUser, "admin")
	f.memberUser = dbfx.User(t, "Baseline wiki member", "baseline-wiki-member-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, testWorkspaceID, f.memberUser, "member")
	dbfx.Cleanup(t, `DELETE FROM project_baseline_revision WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	dbfx.Cleanup(t, `DELETE FROM project_baseline_page WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	dbfx.Cleanup(t, `DELETE FROM project_engineering WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	return f
}

// baselineWikiRequest builds a request with the chi URL params the wiki routes
// need. credential selects the actor; the forged* variants reproduce the
// credential-confusion attacks the handler MUST reject.
func (f baselineWikiFixture) request(credential, method, path string, body any, params map[string]string) *http.Request {
	req := newRequest(method, "/api/projects/"+f.project+path, body)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)
	switch credential {
	case "session":
	case "admin":
		req.Header.Set("X-User-ID", f.adminUser)
	case "member":
		req.Header.Set("X-User-ID", f.memberUser)
	case "pat":
		identity := auth.Identity{UserID: testUserID, CredentialKind: "pat"}
		req = req.WithContext(auth.WithIdentity(req.Context(), identity))
	case "task":
		identity := auth.Identity{UserID: testUserID, CredentialKind: "task", WorkspaceID: testWorkspaceID, AgentID: f.agent, TaskID: f.task}
		req = req.WithContext(auth.WithIdentity(req.Context(), identity))
		req.Header.Set("X-Actor-Source", "task_token")
	case "forged_wrong_user":
		identity := auth.Identity{UserID: testUserID, CredentialKind: "pat"}
		req = req.WithContext(auth.WithIdentity(req.Context(), identity))
		req.Header.Set("X-User-ID", uuid.NewString())
	case "forged_bad_user_header":
		req.Header.Set("X-User-ID", "not-a-uuid")
	case "forged_task_no_source":
		identity := auth.Identity{UserID: testUserID, CredentialKind: "task", WorkspaceID: testWorkspaceID, AgentID: f.agent, TaskID: f.task}
		req = req.WithContext(auth.WithIdentity(req.Context(), identity))
	case "forged_task_cloud_source":
		identity := auth.Identity{UserID: testUserID, CredentialKind: "task", WorkspaceID: testWorkspaceID, AgentID: f.agent, TaskID: f.task}
		req = req.WithContext(auth.WithIdentity(req.Context(), identity))
		req.Header.Set("X-Actor-Source", "cloud_pat")
	case "forged_task_other_workspace":
		identity := auth.Identity{CredentialKind: "task", WorkspaceID: uuid.NewString(), AgentID: f.agent, TaskID: f.task}
		req = req.WithContext(auth.WithIdentity(req.Context(), identity))
		req.Header.Set("X-Actor-Source", "task_token")
	}
	values := map[string]string{"id": f.project}
	for key, value := range params {
		values[key] = value
	}
	// withURLParam replaces the whole route context on every call, so install
	// every param at once on one fresh context.
	rctx := chi.NewRouteContext()
	for key, value := range values {
		rctx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func (f baselineWikiFixture) enable() {
	f.t.Helper()
	testutil.Call(f.t, testHandler.LabrastroPatchEngineering, f.request("session", "PATCH", "/engineering", map[string]any{"enabled": true}, nil)).Want(200)
}

// ---------- response shapes ----------

type baselineWikiWriteOut struct {
	Page     wikiPageResponse     `json:"page"`
	Revision wikiRevisionResponse `json:"revision"`
	Rebased  bool                 `json:"rebased"`
}

type baselineWikiFlipOut struct {
	Pages []baselineWikiWriteOut `json:"pages"`
}

type baselineWikiTreeOut struct {
	Pages  []wikiTreePage `json:"pages"`
	Limits struct {
		MaxDepth int `json:"max_depth"`
		MaxPages int `json:"max_pages"`
	} `json:"limits"`
}

type baselineWikiReadOut struct {
	Page          wikiPageResponse       `json:"page"`
	Revision      wikiRevisionResponse   `json:"revision"`
	Content       string                 `json:"content_markdown"`
	Sections      []engineering.Section  `json:"sections"`
	Links         []engineering.WikiLink `json:"links"`
	Backlinks     []engineering.Backlink `json:"backlinks"`
	RelatedIssues []wikiRelatedIssue     `json:"related_issues"`
}

type baselineWikiConflictOut struct {
	Code    string `json:"code"`
	Error   string `json:"error"`
	Current struct {
		RevisionNumber int32  `json:"revision_number"`
		Kind           string `json:"kind"`
		CreatedByType  string `json:"created_by_type"`
		ChangeSummary  string `json:"change_summary"`
	} `json:"current"`
}

// ---------- typed operations ----------

func (f baselineWikiFixture) create(credential, title, slug string, parent, after *string, content string) baselineWikiWriteOut {
	f.t.Helper()
	body := map[string]any{"title": title}
	if slug != "" {
		body["slug"] = slug
	}
	if parent != nil {
		body["parent"] = *parent
	}
	if after != nil {
		body["after"] = *after
	}
	if content != "" {
		body["content_markdown"] = content
	}
	var out baselineWikiWriteOut
	testutil.Call(f.t, testHandler.LabrastroCreateWikiPage, f.request(credential, "POST", "/baseline/pages", body, nil)).Want(201).JSON(&out)
	return out
}

func (f baselineWikiFixture) tryCreate(credential string, body map[string]any) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroCreateWikiPage, f.request(credential, "POST", "/baseline/pages", body, nil))
}

func (f baselineWikiFixture) fullWrite(credential, page string, base int32, content string) baselineWikiWriteOut {
	f.t.Helper()
	var out baselineWikiWriteOut
	testutil.Call(f.t, testHandler.LabrastroWriteWikiPageContent, f.request(credential, "PUT", "/baseline/pages/"+page+"/content", map[string]any{
		"base_revision_number": base, "content_markdown": content,
	}, map[string]string{"page": page})).Want(200).JSON(&out)
	return out
}

func (f baselineWikiFixture) tryWrite(credential, page string, body map[string]any) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroWriteWikiPageContent, f.request(credential, "PUT", "/baseline/pages/"+page+"/content", body, map[string]string{"page": page}))
}

func (f baselineWikiFixture) tryPatch(credential, page string, body map[string]any) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroPatchWikiPage, f.request(credential, "PATCH", "/baseline/pages/"+page, body, map[string]string{"page": page}))
}

func (f baselineWikiFixture) tryFlip(credential, page string, body map[string]any, archiving bool) *testutil.Response {
	f.t.Helper()
	action := "restore"
	handler := testHandler.LabrastroRestoreWikiPage
	if archiving {
		action, handler = "archive", testHandler.LabrastroArchiveWikiPage
	}
	return testutil.Call(f.t, handler, f.request(credential, "POST", "/baseline/pages/"+page+"/"+action, body, map[string]string{"page": page}))
}

func (f baselineWikiFixture) flip(credential, page string, base int32, body map[string]any, archiving bool) baselineWikiFlipOut {
	f.t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	body["base_revision_number"] = base
	var out baselineWikiFlipOut
	f.tryFlip(credential, page, body, archiving).Want(200).JSON(&out)
	return out
}

func (f baselineWikiFixture) tryRollback(credential, page string, body map[string]any) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroRollbackWikiPage, f.request(credential, "POST", "/baseline/pages/"+page+"/rollback", body, map[string]string{"page": page}))
}

func (f baselineWikiFixture) tree() baselineWikiTreeOut {
	f.t.Helper()
	var out baselineWikiTreeOut
	testutil.Call(f.t, testHandler.LabrastroWikiTree, f.request("session", "GET", "/baseline/tree", nil, nil)).Want(200).JSON(&out)
	return out
}

func (f baselineWikiFixture) readPage(page, query string) baselineWikiReadOut {
	f.t.Helper()
	var out baselineWikiReadOut
	testutil.Call(f.t, testHandler.LabrastroReadWikiPage, f.request("session", "GET", "/baseline/pages/"+page+query, nil, map[string]string{"page": page})).Want(200).JSON(&out)
	return out
}

func (f baselineWikiFixture) currentPage(slug string) wikiTreePage {
	f.t.Helper()
	for _, page := range f.tree().Pages {
		if page.Slug == slug {
			return page
		}
	}
	f.t.Fatalf("page %q not in tree", slug)
	return wikiTreePage{}
}

// ---------- assertions ----------

func wantBaselineWikiCode(t *testing.T, response *testutil.Response, status int, code string) {
	t.Helper()
	var out struct {
		Code string `json:"code"`
	}
	response.Want(status).JSON(&out)
	if out.Code != code {
		t.Fatalf("code=%q want %q (body %s)", out.Code, code, response.Text())
	}
}

func baselineWikiConflict(t *testing.T, response *testutil.Response, currentNumber int32) {
	t.Helper()
	var out baselineWikiConflictOut
	response.Want(409).JSON(&out)
	if out.Code != "baseline_conflict" {
		t.Fatalf("code=%q want baseline_conflict (body %s)", out.Code, response.Text())
	}
	if out.Current.RevisionNumber != currentNumber {
		t.Fatalf("conflict current.revision_number=%d want %d", out.Current.RevisionNumber, currentNumber)
	}
	if out.Current.Kind == "" || out.Current.CreatedByType == "" {
		t.Fatalf("conflict current payload incomplete: %+v", out.Current)
	}
}

// assertDensePositions checks I3a: every sibling set is densely numbered
// 0..n-1 in (position, id) order.
func assertDensePositions(t *testing.T, pages []wikiTreePage) {
	t.Helper()
	byParent := map[string][]wikiTreePage{}
	for _, page := range pages {
		key := "root"
		if page.ParentID != nil {
			key = *page.ParentID
		}
		byParent[key] = append(byParent[key], page)
	}
	for _, siblings := range byParent {
		for want, page := range siblings {
			if int(page.Position) != want {
				t.Fatalf("sibling order not dense: %s position=%d want %d (set %+v)", page.Slug, page.Position, want, siblings)
			}
		}
	}
}

// assertSnapshot checks I2a: a fresh revision carries the post-op page row.
func assertSnapshot(t *testing.T, out baselineWikiWriteOut) {
	t.Helper()
	if out.Revision.Title != out.Page.Title || out.Revision.Slug != out.Page.Slug ||
		out.Revision.Position != out.Page.Position ||
		(out.Revision.ParentID == nil) != (out.Page.ParentID == nil) ||
		out.Revision.ParentID != nil && *out.Revision.ParentID != *out.Page.ParentID {
		t.Fatalf("revision snapshot diverges from page row: rev=%+v page=%+v", out.Revision, out.Page)
	}
	archivedRev, archivedPage := out.Revision.ArchivedAt != nil, out.Page.ArchivedAt != nil
	if archivedRev != archivedPage {
		t.Fatalf("revision archived=%v page archived=%v", archivedRev, archivedPage)
	}
	if out.Revision.PageID != out.Page.ID {
		t.Fatalf("revision page_id=%s want %s", out.Revision.PageID, out.Page.ID)
	}
}

func revisionCount(t *testing.T, project, slug string) int {
	t.Helper()
	return dbfx.Count(t, `SELECT count(*) FROM project_baseline_revision r
		JOIN project_baseline_page p ON p.id = r.page_id
		WHERE p.workspace_id = $1 AND p.project_id = $2 AND p.slug = $3`, testWorkspaceID, project, slug)
}

// ---------- 1. enable leaves the wiki empty ----------

func TestLabrastroBaselineWikiEnableLeavesEmptyTree(t *testing.T) {
	f := newBaselineWikiFixture(t)
	wantBaselineWikiCode(t, f.tryCreate("session", map[string]any{"title": "早了"}), 409, "engineering_disabled")

	var engineeringOut struct {
		Engineering struct {
			Enabled bool `json:"enabled"`
		} `json:"engineering"`
		Chapters []any `json:"chapters"`
	}
	testutil.Call(t, testHandler.LabrastroGetEngineering, f.request("session", "GET", "/engineering", nil, nil)).Want(200).JSON(&engineeringOut)
	if engineeringOut.Engineering.Enabled || engineeringOut.Chapters != nil && len(engineeringOut.Chapters) != 0 {
		t.Fatalf("pre-enable state: %+v", engineeringOut)
	}

	f.enable()
	tree := f.tree()
	if len(tree.Pages) != 0 {
		t.Fatalf("enabled project already has pages: %+v", tree.Pages)
	}
	if tree.Limits.MaxDepth != 6 || tree.Limits.MaxPages != 500 {
		t.Fatalf("limits=%+v", tree.Limits)
	}
	testutil.Call(t, testHandler.LabrastroGetEngineering, f.request("session", "GET", "/engineering", nil, nil)).Want(200).JSON(&engineeringOut)
	if !engineeringOut.Engineering.Enabled || len(engineeringOut.Chapters) != 0 {
		t.Fatalf("post-enable state: %+v", engineeringOut)
	}
	for _, table := range []string{"project_baseline_page", "project_baseline_revision"} {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", f.project); n != 0 {
			t.Fatalf("enable created %s rows: %d", table, n)
		}
	}
}

// ---------- 2. human/agent parity and forged credentials ----------

func TestLabrastroBaselineWikiActorParity(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	for _, credential := range []string{"session", "admin", "member", "pat", "task"} {
		slug := "parity-" + credential
		created := f.create(credential, "Parity "+credential, slug, nil, nil, "## 初稿\n正文")
		if created.Page.Slug != slug || created.Revision.RevisionKind != "create" || created.Revision.RevisionNumber != 1 {
			t.Fatalf("%s create: %+v", credential, created)
		}
		assertSnapshot(t, created)
		written := f.fullWrite(credential, slug, 1, "## 次稿\n正文 v2")
		if written.Rebased || written.Revision.RevisionNumber != 2 {
			t.Fatalf("%s write: %+v", credential, written)
		}
		renamed := f.tryPatch(credential, slug, map[string]any{"base_revision_number": 2, "title": "Parity " + credential + " v2"})
		renamed.Want(200)
		moved := f.tryPatch(credential, slug, map[string]any{"base_revision_number": 3, "parent": "root", "after": "first"})
		moved.Want(200)
		archived := f.flip(credential, slug, 4, nil, true)
		if len(archived.Pages) != 1 {
			t.Fatalf("%s archive: %+v", credential, archived)
		}
		assertSnapshot(t, archived.Pages[0])
		restored := f.flip(credential, slug, 5, nil, false)
		if len(restored.Pages) != 1 || restored.Pages[0].Page.ArchivedAt != nil {
			t.Fatalf("%s restore: %+v", credential, restored)
		}
		rolled := f.tryRollback(credential, slug, map[string]any{"revision_number": 2, "base_revision_number": 6, "content_only": true})
		var rollOut baselineWikiWriteOut
		rolled.Want(201).JSON(&rollOut)
		if rollOut.Revision.ContentMarkdown != "## 次稿\n正文 v2" {
			t.Fatalf("%s rollback content: %+v", credential, rollOut)
		}
		assertDensePositions(t, f.tree().Pages)
	}
}

func TestLabrastroBaselineWikiForgedCredentials(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	for _, credential := range []string{
		"forged_wrong_user", "forged_bad_user_header", "forged_task_no_source",
		"forged_task_cloud_source", "forged_task_other_workspace",
	} {
		t.Run(credential, func(t *testing.T) {
			body := map[string]any{"title": "伪造", "slug": "forged-" + strings.ReplaceAll(strings.TrimPrefix(credential, "forged_"), "_", "-")}
			wantBaselineWikiCode(t, f.tryCreate(credential, body), 403, "baseline_credential_denied")
			wantBaselineWikiCode(t, f.tryWrite(credential, "nope", map[string]any{"base_revision_number": 1, "content_markdown": "x"}), 403, "baseline_credential_denied")
			wantBaselineWikiCode(t, f.tryPatch(credential, "nope", map[string]any{"base_revision_number": 1, "title": "x"}), 403, "baseline_credential_denied")
			wantBaselineWikiCode(t, f.tryFlip(credential, "nope", map[string]any{"base_revision_number": 1}, true), 403, "baseline_credential_denied")
			wantBaselineWikiCode(t, f.tryRollback(credential, "nope", map[string]any{"revision_number": 1, "base_revision_number": 1}), 403, "baseline_credential_denied")
		})
	}
}

// ---------- 3. full lifecycle ----------

func TestLabrastroBaselineWikiLifecycle(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()

	alpha := f.create("task", "甲", "alpha", nil, nil, "正文 v1")
	if alpha.Page.ParentID != nil || alpha.Page.Position != 0 || alpha.Page.CurrentRevisionNumber != 1 {
		t.Fatalf("alpha create: %+v", alpha.Page)
	}
	assertSnapshot(t, alpha)
	beta := f.create("session", "乙", "beta", nil, new("alpha"), "正文 v1")
	if beta.Page.Position != 1 {
		t.Fatalf("beta position=%d", beta.Page.Position)
	}
	f.create("member", "丙", "gamma", nil, new("first"), "")
	if got := f.currentPage("gamma"); got.Position != 0 || got.Depth != 1 {
		t.Fatalf("gamma after insert-first: %+v", got)
	}
	assertDensePositions(t, f.tree().Pages)

	// Full write v2.
	v2 := f.fullWrite("task", "alpha", 1, "## Alpha 一\n正文甲一\n## Alpha 二\n正文甲二")
	if v2.Revision.RevisionNumber != 2 || v2.Revision.ContentMarkdown == "" || v2.Revision.BaseRevisionID == nil {
		t.Fatalf("full write: %+v", v2)
	}
	assertSnapshot(t, v2)

	// Section write replaces one section; a later section delete removes another.
	v3 := f.tryWrite("session", "alpha", map[string]any{
		"base_revision_number": 2, "section": "Alpha 二", "content_markdown": "## Alpha 二\n正文甲二改",
	})
	var sectionOut baselineWikiWriteOut
	v3.Want(200).JSON(&sectionOut)
	if sectionOut.Rebased {
		t.Fatal("fresh-base section write reported rebased")
	}
	assertSnapshot(t, sectionOut)
	v4 := f.tryWrite("task", "alpha", map[string]any{"base_revision_number": 3, "delete_section": "Alpha 一"})
	v4.Want(200)
	read := f.readPage("alpha", "")
	if trimmed := strings.TrimRight(read.Content, "\n"); trimmed != "## Alpha 二\n正文甲二改" {
		t.Fatalf("after section ops content=%q", trimmed)
	}
	sections := f.readPage("alpha", "?section="+url.QueryEscape("Alpha 二"))
	if len(sections.Sections) != 1 || sections.Sections[0].Title != "Alpha 二" {
		t.Fatalf("section read: %+v", sections.Sections)
	}

	// Rename keeps the page row position.
	renamed := f.tryPatch("session", "alpha", map[string]any{"base_revision_number": 4, "title": "甲改", "slug": "alpha-2"})
	var renameOut baselineWikiWriteOut
	renamed.Want(200).JSON(&renameOut)
	if renameOut.Rebased || renameOut.Page.Slug != "alpha-2" || renameOut.Page.Position != 1 || renameOut.Page.ParentID != nil {
		t.Fatalf("rename: %+v", renameOut)
	}
	assertSnapshot(t, renameOut)

	// Move under another page (parent + after).
	moved := f.tryPatch("task", "alpha-2", map[string]any{"base_revision_number": 5, "parent": "beta"})
	var moveOut baselineWikiWriteOut
	moved.Want(200).JSON(&moveOut)
	if moveOut.Page.ParentID == nil || *moveOut.Page.ParentID != beta.Page.ID || moveOut.Page.Position != 0 || f.currentPage("alpha-2").Depth != 2 {
		t.Fatalf("move: %+v", moveOut.Page)
	}
	if got := f.currentPage("gamma"); got.Position != 0 || f.currentPage("beta").Position != 1 {
		t.Fatalf("origin siblings not reflowed: gamma=%d beta=%d", got.Position, f.currentPage("beta").Position)
	}
	assertSnapshot(t, moveOut)
	assertDensePositions(t, f.tree().Pages)

	// Recursive archive: each flipped page gets exactly one archive revision.
	beforeAlpha, beforeBeta := revisionCount(t, f.project, "alpha-2"), revisionCount(t, f.project, "beta")
	archived := f.flip("session", "beta", f.currentPage("beta").CurrentRevisionNumber, map[string]any{"recursive": true}, true)
	if len(archived.Pages) != 2 {
		t.Fatalf("recursive archive flipped %d pages", len(archived.Pages))
	}
	flipped := map[string]bool{}
	for _, item := range archived.Pages {
		flipped[item.Page.Slug] = true
		assertSnapshot(t, item)
		if item.Page.ArchivedAt == nil || item.Revision.RevisionKind != "archive" {
			t.Fatalf("archive result: %+v", item)
		}
	}
	if !flipped["beta"] || !flipped["alpha-2"] {
		t.Fatalf("archive set: %+v", flipped)
	}
	if got := revisionCount(t, f.project, "alpha-2"); got != beforeAlpha+1 {
		t.Fatalf("alpha-2 revisions %d want %d", got, beforeAlpha+1)
	}
	if got := revisionCount(t, f.project, "beta"); got != beforeBeta+1 {
		t.Fatalf("beta revisions %d want %d", got, beforeBeta+1)
	}
	tree := f.tree()
	found := 0
	for _, page := range tree.Pages {
		if flipped[page.Slug] {
			found++
			if page.ArchivedAt == nil {
				t.Fatalf("tree lost archived flag for %s", page.Slug)
			}
		}
	}
	if found != 2 {
		t.Fatalf("tree does not include archived pages: %+v", tree.Pages)
	}
	assertDensePositions(t, tree.Pages)

	// Writing an archived page is rejected.
	wantBaselineWikiCode(t, f.tryWrite("session", "beta", map[string]any{
		"base_revision_number": f.currentPage("beta").CurrentRevisionNumber, "content_markdown": "x",
	}), 409, "baseline_page_archived")

	// Recursive restore, then a full and a content-only rollback.
	restored := f.flip("task", "beta", f.currentPage("beta").CurrentRevisionNumber, map[string]any{"recursive": true}, false)
	if len(restored.Pages) != 2 || restored.Pages[0].Page.ArchivedAt != nil {
		t.Fatalf("restore: %+v", restored)
	}
	rolled := f.tryRollback("session", "alpha-2", map[string]any{
		"revision_number": 2, "base_revision_number": f.currentPage("alpha-2").CurrentRevisionNumber,
	})
	var fullRoll baselineWikiWriteOut
	rolled.Want(201).JSON(&fullRoll)
	if fullRoll.Page.Title != "甲" || fullRoll.Page.Slug != "alpha" || fullRoll.Page.ParentID != nil {
		t.Fatalf("full rollback row: %+v", fullRoll.Page)
	}
	if fullRoll.Revision.ContentMarkdown != "## Alpha 一\n正文甲一\n## Alpha 二\n正文甲二" || fullRoll.Revision.RestoredFromRevisionID == nil {
		t.Fatalf("full rollback revision: %+v", fullRoll.Revision)
	}
	assertSnapshot(t, fullRoll)
	contentRoll := f.tryRollback("task", "alpha", map[string]any{
		"revision_number": 4, "base_revision_number": f.currentPage("alpha").CurrentRevisionNumber, "content_only": true,
	})
	var contentRollOut baselineWikiWriteOut
	contentRoll.Want(201).JSON(&contentRollOut)
	if contentRollOut.Page.Slug != "alpha" || contentRollOut.Revision.RevisionKind != "rollback" {
		t.Fatalf("content-only rollback: %+v", contentRollOut)
	}
	assertSnapshot(t, contentRollOut)
	assertDensePositions(t, f.tree().Pages)
}

// ---------- 4. rebase matrix ----------

func TestLabrastroBaselineWikiRebaseMatrix(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()

	t.Run("stale full write rebases over rename", func(t *testing.T) {
		f.create("session", "重命名页", "rebase-rename", nil, nil, "旧正文")
		f.tryPatch("task", "rebase-rename", map[string]any{"base_revision_number": 1, "title": "新标题"}).Want(200)
		out := f.fullWrite("session", "rebase-rename", 1, "新正文")
		if !out.Rebased || out.Revision.RevisionNumber != 3 || out.Page.Title != "新标题" {
			t.Fatalf("rebase over rename: %+v", out)
		}
	})

	t.Run("stale full write conflicts over content write", func(t *testing.T) {
		f.create("session", "冲突页", "rebase-content", nil, nil, "v1")
		f.fullWrite("task", "rebase-content", 1, "v2 by agent")
		baselineWikiConflict(t, f.tryWrite("session", "rebase-content", map[string]any{
			"base_revision_number": 1, "content_markdown": "v2 by human",
		}), 2)
	})

	t.Run("different sections merge on stale base", func(t *testing.T) {
		f.create("session", "合并页", "rebase-merge", nil, nil, "## 甲\n甲文\n## 乙\n乙文")
		f.tryWrite("task", "rebase-merge", map[string]any{
			"base_revision_number": 1, "section": "甲", "content_markdown": "## 甲\n甲文改",
		}).Want(200)
		var out baselineWikiWriteOut
		f.tryWrite("session", "rebase-merge", map[string]any{
			"base_revision_number": 1, "section": "乙", "content_markdown": "## 乙\n乙文改",
		}).Want(200).JSON(&out)
		if !out.Rebased {
			t.Fatal("stale section merge not marked rebased")
		}
		read := f.readPage("rebase-merge", "").Content
		for _, want := range []string{"## 甲", "甲文改", "## 乙", "乙文改"} {
			if !strings.Contains(read, want) {
				t.Fatalf("merged content missing %q: %q", want, read)
			}
		}
	})

	t.Run("same section stale write conflicts", func(t *testing.T) {
		f.create("session", "同节页", "rebase-same", nil, nil, "## 甲\n甲文")
		f.tryWrite("task", "rebase-same", map[string]any{
			"base_revision_number": 1, "section": "甲", "content_markdown": "## 甲\nagent 改",
		}).Want(200)
		baselineWikiConflict(t, f.tryWrite("session", "rebase-same", map[string]any{
			"base_revision_number": 1, "section": "甲", "content_markdown": "## 甲\nhuman 改",
		}), 2)
	})

	t.Run("stale section write conflicts over archive", func(t *testing.T) {
		f.create("session", "归档节页", "rebase-archive", nil, nil, "## 甲\n甲文")
		f.flip("session", "rebase-archive", 1, nil, true)
		wantBaselineWikiCode(t, f.tryWrite("task", "rebase-archive", map[string]any{
			"base_revision_number": 1, "section": "甲", "content_markdown": "## 甲\n改",
		}), 409, "baseline_page_archived")
	})

	// The contract's rename rebase window is {rename, archive, restore,
	// rollback}: a move alone does NOT conflict, the rename rebases and keeps
	// the moved parent/position.
	t.Run("rename on stale base after move rebases", func(t *testing.T) {
		f.create("session", "父页", "rebase-parent", nil, nil, "正文")
		f.create("session", "移动改名页", "rebase-move-rename", nil, nil, "正文")
		f.tryPatch("task", "rebase-move-rename", map[string]any{"base_revision_number": 1, "parent": "rebase-parent"}).Want(200)
		var out baselineWikiWriteOut
		f.tryPatch("session", "rebase-move-rename", map[string]any{
			"base_revision_number": 1, "title": "新名",
		}).Want(200).JSON(&out)
		if !out.Rebased || out.Page.ParentID == nil {
			t.Fatalf("rename over move: %+v", out)
		}
		baselineWikiConflict(t, f.tryPatch("task", "rebase-move-rename", map[string]any{
			"base_revision_number": 2, "title": "又新名",
		}), 3)
	})

	t.Run("move stale after another move conflicts", func(t *testing.T) {
		f.create("session", "父一", "rebase-p1", nil, nil, "正文")
		f.create("session", "父二", "rebase-p2", nil, nil, "正文")
		f.create("session", "连移页", "rebase-move-move", nil, nil, "正文")
		f.tryPatch("task", "rebase-move-move", map[string]any{"base_revision_number": 1, "parent": "rebase-p1"}).Want(200)
		baselineWikiConflict(t, f.tryPatch("session", "rebase-move-move", map[string]any{
			"base_revision_number": 1, "parent": "rebase-p2",
		}), 2)
	})

	t.Run("archive restore rollback are strict CAS", func(t *testing.T) {
		f.create("session", "CAS 页", "rebase-cas", nil, nil, "正文")
		f.fullWrite("task", "rebase-cas", 1, "v2")
		current := f.currentPage("rebase-cas").CurrentRevisionNumber
		baselineWikiConflict(t, f.tryFlip("session", "rebase-cas", map[string]any{"base_revision_number": current - 1}, true), current)
		baselineWikiConflict(t, f.tryRollback("task", "rebase-cas", map[string]any{
			"revision_number": 1, "base_revision_number": current - 1,
		}), current)
		f.flip("session", "rebase-cas", current, nil, true)
		restored := f.currentPage("rebase-cas").CurrentRevisionNumber
		baselineWikiConflict(t, f.tryFlip("task", "rebase-cas", map[string]any{"base_revision_number": restored - 1}, false), restored)
		f.flip("session", "rebase-cas", restored, nil, false)
	})
}

// ---------- 5. review #8 counterexample ----------

func TestLabrastroBaselineWikiMoveOrderCounterexample(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	pageA := f.create("session", "A", "counter-a", nil, nil, "A 正文")
	f.create("session", "B", "counter-b", nil, nil, "B 正文")

	// Move B before A: A becomes position 1 with NO new revision for A.
	moved := f.tryPatch("task", "counter-b", map[string]any{"base_revision_number": 1, "parent": "root", "after": "first"})
	var moveOut baselineWikiWriteOut
	moved.Want(200).JSON(&moveOut)
	if moveOut.Page.Position != 0 {
		t.Fatalf("B position=%d", moveOut.Page.Position)
	}
	afterMove := f.currentPage("counter-a")
	if afterMove.Position != 1 || afterMove.CurrentRevisionNumber != 1 || afterMove.RevisionCount != 1 {
		t.Fatalf("A disturbed by sibling move: %+v", afterMove)
	}
	if got := revisionCount(t, f.project, "counter-a"); got != 1 {
		t.Fatalf("A revision rows=%d want 1", got)
	}
	assertDensePositions(t, f.tree().Pages)

	// Rename A: revision advances, page position stays 1.
	renamed := f.tryPatch("session", "counter-a", map[string]any{"base_revision_number": 1, "title": "A 改名"})
	var renameOut baselineWikiWriteOut
	renamed.Want(200).JSON(&renameOut)
	if renameOut.Revision.RevisionNumber != 2 || renameOut.Page.Position != 1 {
		t.Fatalf("rename after move: %+v", renameOut)
	}

	// Content write on A's PRE-move base rebases; position stays 1.
	written := f.fullWrite("task", "counter-a", 1, "A 正文 v2")
	if !written.Rebased || written.Revision.RevisionNumber != 3 {
		t.Fatalf("rebased write: %+v", written)
	}
	if written.Page.Position != 1 || written.Revision.Position != 1 || f.currentPage("counter-a").Position != 1 {
		t.Fatalf("position drifted: page=%d rev=%d tree=%d", written.Page.Position, written.Revision.Position, f.currentPage("counter-a").Position)
	}
	if written.Page.ID != pageA.Page.ID || written.Page.ParentID != nil {
		t.Fatalf("rebased write changed identity/parent: %+v", written.Page)
	}
	assertDensePositions(t, f.tree().Pages)
}

// ---------- 6. tree invariants ----------

func TestLabrastroBaselineWikiTreeInvariants(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()

	t.Run("cycle rejected", func(t *testing.T) {
		f.create("session", "环父", "cycle-parent", nil, nil, "正文")
		f.create("session", "环子", "cycle-child", new("cycle-parent"), nil, "正文")
		wantBaselineWikiCode(t, f.tryPatch("session", "cycle-parent", map[string]any{
			"base_revision_number": 1, "parent": "cycle-child",
		}), 409, "baseline_page_cycle")
	})

	t.Run("depth beyond six rejected", func(t *testing.T) {
		slug := "depth-1"
		f.create("session", "层一", slug, nil, nil, "正文")
		for level := 2; level <= 6; level++ {
			child := "depth-" + string(rune('0'+level))
			f.create("session", "层"+string(rune('0'+level)), child, new(slug), nil, "正文")
			slug = child
		}
		wantBaselineWikiCode(t, f.tryCreate("session", map[string]any{
			"title": "层七", "slug": "depth-7", "parent": slug,
		}), 422, "baseline_tree_too_deep")
		if got := f.currentPage("depth-6"); got.Depth != 6 {
			t.Fatalf("depth-6 depth=%d", got.Depth)
		}
	})

	t.Run("slug collisions including archived", func(t *testing.T) {
		f.create("session", "占用页", "taken", nil, nil, "正文")
		wantBaselineWikiCode(t, f.tryCreate("session", map[string]any{"title": "重名", "slug": "taken"}), 409, "baseline_slug_taken")
		f.flip("session", "taken", 1, nil, true)
		wantBaselineWikiCode(t, f.tryCreate("session", map[string]any{"title": "归档重名", "slug": "taken"}), 409, "baseline_slug_taken")
	})

	t.Run("uuid-shaped slug rejected", func(t *testing.T) {
		wantBaselineWikiCode(t, f.tryCreate("session", map[string]any{
			"title": "UUID 形", "slug": uuid.NewString(),
		}), 400, "invalid_request")
	})

	t.Run("archive non-leaf without recursive", func(t *testing.T) {
		f.create("session", "叶子父", "has-children", nil, nil, "正文")
		f.create("session", "叶子子", "has-children-child", new("has-children"), nil, "正文")
		wantBaselineWikiCode(t, f.tryFlip("session", "has-children", map[string]any{"base_revision_number": 1}, true), 409, "baseline_page_has_children")
	})

	t.Run("restore parent archived and parent override", func(t *testing.T) {
		f.create("session", "新家", "restore-home", nil, nil, "正文")
		f.create("session", "旧父", "restore-old-parent", nil, nil, "正文")
		f.create("session", "迁移子", "restore-child", new("restore-old-parent"), nil, "正文")
		f.flip("session", "restore-old-parent", 1, map[string]any{"recursive": true}, true)
		childCurrent := f.currentPage("restore-child").CurrentRevisionNumber
		wantBaselineWikiCode(t, f.tryFlip("task", "restore-child", map[string]any{"base_revision_number": childCurrent}, false), 409, "baseline_parent_archived")
		restored := f.flip("task", "restore-child", childCurrent, map[string]any{"parent": "restore-home"}, false)
		if len(restored.Pages) != 1 {
			t.Fatalf("restore with parent override: %+v", restored)
		}
		if restored.Pages[0].Page.ParentID == nil || f.currentPage("restore-home").ID != *restored.Pages[0].Page.ParentID {
			t.Fatalf("restore did not reparent: %+v", restored.Pages[0].Page)
		}
	})
}

// ---------- 7. retired endpoints ----------

func TestLabrastroBaselineWikiRetiredEndpoints(t *testing.T) {
	f := newBaselineWikiFixture(t)
	for range 3 {
		wantBaselineWikiCode(t, testutil.Call(t, writeBaselineAPIRetired, f.request("session", "GET", "/baseline", nil, nil)), 410, "baseline_api_retired")
	}
}

// ---------- 8. links, backlinks, related issues ----------

func TestLabrastroBaselineWikiLinksBacklinksAndIssues(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	f.create("session", "目标", "link-target", nil, nil, "## 目标节\n目标正文")
	f.create("session", "来源", "link-source", nil, nil, "看 [[link-target]] 和 [[link-target#目标节]]。\n自引 [[link-source]] 不算反向链接。")
	issue := dbfx.Issue(t, "关联 issue", testutil.Cols{"project_id": f.project})
	f.fullWrite("task", "link-target", 1, "## 目标节\n目标正文\n\n## 参考\n见 [[link-source]]")
	f.tryWrite("session", "link-target", map[string]any{
		"base_revision_number": 2, "section": "目标节", "content_markdown": "## 目标节\n目标正文改", "source_issue_id": issue,
	}).Want(200)

	out := f.readPage("link-target", "?with=links,backlinks,related_issues")
	if len(out.Links) == 0 {
		t.Fatal("no forward links")
	}
	resolved := 0
	for _, link := range out.Links {
		if link.Raw == "link-source" && link.State == "resolved" && link.TargetSlug == "link-source" {
			resolved++
		}
	}
	if resolved != 1 {
		t.Fatalf("resolved [[link-source]] links=%d: %+v", resolved, out.Links)
	}
	if len(out.Backlinks) == 0 {
		t.Fatal("no backlinks")
	}
	for _, backlink := range out.Backlinks {
		if backlink.Slug != "link-source" {
			t.Fatalf("backlinks must exclude the page itself: %+v", out.Backlinks)
		}
	}
	if len(out.RelatedIssues) != 1 || out.RelatedIssues[0].ID != issue {
		t.Fatalf("related issues: %+v want [%s]", out.RelatedIssues, issue)
	}

	source := f.readPage("link-source", "?with=links")
	sectionLink := false
	for _, link := range source.Links {
		if link.Section == "目标节" && link.State == "resolved" && link.TargetSlug == "link-target" && link.SectionAnchor != "" {
			sectionLink = true
		}
	}
	if !sectionLink {
		t.Fatalf("no resolved section link: %+v", source.Links)
	}
}

// ---------- 9. activity and search ----------

func TestLabrastroBaselineWikiActivityAndSearch(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	f.create("session", "Quokka 首页", "activity-search", nil, nil, "## 简介\n正文含有 zanzibar-needle 关键词。\n")
	f.fullWrite("task", "activity-search", 1, "## 简介\n正文 v2 仍有 zanzibar-needle 关键词。")
	f.flip("session", "activity-search", 2, nil, true)

	var activity struct {
		Items []struct {
			Slug string `json:"slug"`
			Kind string `json:"kind"`
		} `json:"items"`
	}
	testutil.Call(t, testHandler.LabrastroWikiActivity, f.request("session", "GET", "/baseline/activity?limit=50", nil, nil)).Want(200).JSON(&activity)
	f.flip("session", "activity-search", f.currentPage("activity-search").CurrentRevisionNumber, nil, false)

	kinds := map[string]bool{}
	for _, item := range activity.Items {
		if item.Slug != "activity-search" {
			t.Fatalf("activity leaked other pages: %+v", item)
		}
		kinds[item.Kind] = true
	}
	if !kinds["archive"] {
		t.Fatalf("activity missing archived-page event: %+v", activity.Items)
	}
	for _, kind := range []string{"create", "content"} {
		if !kinds[kind] {
			t.Fatalf("activity missing %s: %+v", kind, activity.Items)
		}
	}

	search := func(query string) []engineering.SearchHit {
		t.Helper()
		var out struct {
			Results []engineering.SearchHit `json:"results"`
		}
		testutil.Call(t, testHandler.LabrastroWikiSearch, f.request("session", "GET", "/baseline/search?q="+query, nil, nil)).Want(200).JSON(&out)
		return out.Results
	}
	titleHits := search("Quokka")
	if len(titleHits) != 1 || titleHits[0].Match != "title" || titleHits[0].Slug != "activity-search" {
		t.Fatalf("title search: %+v", titleHits)
	}
	bodyHits := search("zanzibar-needle")
	if len(bodyHits) != 1 || bodyHits[0].Match != "body" || !strings.Contains(bodyHits[0].Snippet, "zanzibar-needle") {
		t.Fatalf("body search: %+v", bodyHits)
	}
}

// ---------- 10. rollback tree validations ----------

func TestLabrastroBaselineWikiRollbackValidations(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()

	t.Run("slug taken", func(t *testing.T) {
		f.create("session", "回滚占名", "rollback-slug", nil, nil, "正文")
		f.tryPatch("session", "rollback-slug", map[string]any{"base_revision_number": 1, "slug": "rollback-slug-2"}).Want(200)
		f.create("task", "抢注", "rollback-slug", nil, nil, "正文")
		current := f.currentPage("rollback-slug-2").CurrentRevisionNumber
		wantBaselineWikiCode(t, f.tryRollback("session", "rollback-slug-2", map[string]any{
			"revision_number": 1, "base_revision_number": current,
		}), 409, "baseline_slug_taken")
	})

	t.Run("parent archived", func(t *testing.T) {
		f.create("session", "回滚父", "rollback-parent", nil, nil, "正文")
		f.create("session", "回滚子", "rollback-child", new("rollback-parent"), nil, "正文")
		f.flip("session", "rollback-parent", 1, map[string]any{"recursive": true}, true)
		current := f.currentPage("rollback-child").CurrentRevisionNumber
		wantBaselineWikiCode(t, f.tryRollback("task", "rollback-child", map[string]any{
			"revision_number": 1, "base_revision_number": current,
		}), 409, "baseline_parent_archived")
	})

	t.Run("cycle", func(t *testing.T) {
		f.create("session", "回滚环子", "rollback-cycle-child", nil, nil, "正文")
		// v2 of the page records parent = rollback-cycle-child...
		f.create("session", "回滚环页", "rollback-cycle", new("rollback-cycle-child"), nil, "正文")
		// ...then the page is moved to the root and its old parent becomes its
		// own child, so restoring the v2 parent would close a cycle.
		f.tryPatch("session", "rollback-cycle", map[string]any{"base_revision_number": 1, "parent": "root"}).Want(200)
		f.tryPatch("session", "rollback-cycle-child", map[string]any{"base_revision_number": 1, "parent": "rollback-cycle"}).Want(200)
		current := f.currentPage("rollback-cycle").CurrentRevisionNumber
		wantBaselineWikiCode(t, f.tryRollback("session", "rollback-cycle", map[string]any{
			"revision_number": 1, "base_revision_number": current,
		}), 409, "baseline_page_cycle")
	})
}

// ---------- 11. claim description ----------

func TestLabrastroBaselineWikiClaimDescription(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	f.create("session", "总览", "claim-overview", nil, nil, "## 目标\n交付正文")
	f.create("session", "架构", "claim-arch", new("claim-overview"), nil, "## 架构\n分层")
	f.create("session", "细节", "claim-detail", new("claim-arch"), nil, "正文")
	f.create("session", "深处", "claim-deep", new("claim-detail"), nil, "正文")
	// One more sibling at depth 3 proves the directory lists depth<=3 only.
	f.create("session", "深处二", "claim-deep-2", new("claim-arch"), nil, "正文")

	got, err := testHandler.resolveClaimProjectContext(t.Context(), parseUUID(f.project), parseUUID(testWorkspaceID))
	if err != nil {
		t.Fatal(err)
	}
	description := got.Description
	for _, want := range []string{
		"基线 Wiki 目录（共 5 页；slug 标题 vN）：",
		"- claim-overview 总览 v1",
		"-   claim-arch 架构 v1",
		"-     claim-detail 细节 v1",
		"- 另有 2 页，用 `multica project baseline tree " + f.project + "` 查看",
		"multica project baseline write " + f.project,
	} {
		if !strings.Contains(description, want) {
			t.Errorf("description missing %q:\n%s", want, description)
		}
	}
	for _, unwanted := range []string{"claim-deep-2", "待审候选", "candidate", "批注", "annotation"} {
		if strings.Contains(description, unwanted) {
			t.Errorf("description must not contain %q:\n%s", unwanted, description)
		}
	}
	if n := utf8.RuneCountInString(description); n > 2000 {
		t.Fatalf("description %d runes exceeds the 2000 budget", n)
	}
	if !strings.HasPrefix(description, "### 工程管理") {
		t.Fatalf("description lost its header:\n%s", description)
	}
}
