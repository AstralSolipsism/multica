package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-redis/redismock/v9"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestExternalConversationAttachmentDownloadWorkspace(t *testing.T) {
	for _, mode := range []string{"proxy", "presign"} {
		t.Run(mode, func(t *testing.T) {
			uploadDir := t.TempDir()
			t.Setenv("LOCAL_UPLOAD_DIR", uploadDir)
			t.Setenv("ATTACHMENT_DOWNLOAD_MODE", mode)
			t.Setenv("S3_BUCKET", "")
			if mode == "presign" {
				t.Setenv("S3_BUCKET", "attachment-tests")
				t.Setenv("AWS_ENDPOINT_URL", "https://storage.example.test")
				t.Setenv("S3_USE_PATH_STYLE", "true")
				t.Setenv("AWS_ACCESS_KEY_ID", "test-access-key")
				t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret-key")
			}
			router, h := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
			cacheClient, cache := redismock.NewClientMock()
			t.Cleanup(func() { _ = cacheClient.Close() })
			h.MembershipCache = auth.NewMembershipCache(cacheClient)
			fx := testutil.New(testPool, testWorkspaceID, testUserID)
			grantor := fx.User(t, "Attachment grantor", "attachment-grantor-"+mode+"@example.test")
			otherSlug := "attachment-other-" + mode
			otherWorkspace := fx.Workspace(t, "Other attachment workspace", otherSlug)
			fx.Member(t, testWorkspaceID, grantor, "member")
			fx.Member(t, otherWorkspace, grantor, "member")
			memberKey := "mul:auth:member:" + grantor + ":" + otherWorkspace
			memberToken, err := generateTestJWT(grantor, "attachment-grantor-"+mode+"@example.test", "Attachment grantor")
			if err != nil {
				t.Fatal(err)
			}

			attachments := map[string]string{}
			for _, workspace := range []string{testWorkspaceID, otherWorkspace} {
				key := workspace + "/feedback.txt"
				if err := os.MkdirAll(filepath.Join(uploadDir, workspace), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(uploadDir, key), []byte("feedback from "+workspace), 0600); err != nil {
					t.Fatal(err)
				}
				storageURL := "/uploads/" + key
				if mode == "presign" {
					storageURL = "https://storage.example.test/attachment-tests/" + key
				}
				attachments[workspace] = fx.Insert(t, "attachment", testutil.Cols{
					"workspace_id": workspace, "filename": "feedback.txt", "url": storageURL,
					"size_bytes": len("feedback from " + workspace), "content_type": "text/plain",
					"uploader_type": "member", "uploader_id": grantor,
				})
			}
			request := func(token, id, endpoint, workspace string) *httptest.ResponseRecorder {
				t.Helper()
				path := "/api/attachments/" + id + "/" + endpoint
				slug := integrationTestWorkspaceSlug
				if workspace == otherWorkspace {
					slug = otherSlug
				}
				if workspace != "" {
					path += "?workspace_id=" + workspace + "&workspace_slug=" + slug
				}
				req := httptest.NewRequest(http.MethodGet, path, nil)
				req.Header.Set("Authorization", "Bearer "+token)
				// Auth must overwrite forged actor and workspace claims for task tokens.
				req.Header.Set("X-Actor-Source", "member")
				if workspace != "" {
					req.Header.Set("X-Workspace-ID", workspace)
					req.Header.Set("X-Workspace-Slug", slug)
				}
				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)
				return w
			}
			assertDownload := func(t *testing.T, w *httptest.ResponseRecorder, workspace string) {
				t.Helper()
				if mode == "proxy" {
					if w.Code != http.StatusOK || w.Body.String() != "feedback from "+workspace {
						t.Fatalf("proxy download: %d %s", w.Code, w.Body.String())
					}
					return
				}
				location, err := url.Parse(w.Header().Get("Location"))
				if w.Code != http.StatusFound || err != nil || location.Host != "storage.example.test" ||
					!strings.HasSuffix(location.Path, "/"+workspace+"/feedback.txt") || location.Query().Get("X-Amz-Signature") == "" {
					t.Fatalf("presigned download: %d %q (%v)", w.Code, w.Header().Get("Location"), err)
				}
			}

			// A member viewing workspace A can still follow B's link. This also
			// exercises a miss/set and a hit in B's membership cache.
			cache.ExpectGet(memberKey).RedisNil()
			cache.ExpectSet(memberKey, "1", auth.MembershipCacheTTL).SetVal("OK")
			assertDownload(t, request(memberToken, attachments[otherWorkspace], "download", testWorkspaceID), otherWorkspace)
			cache.ExpectGet(memberKey).SetVal("1")
			assertDownload(t, request(memberToken, attachments[otherWorkspace], "download", ""), otherWorkspace)
			cache.ExpectGet("mul:auth:member:" + testUserID + ":" + otherWorkspace).RedisNil()
			if w := request(testToken, attachments[otherWorkspace], "download", testWorkspaceID); w.Code != http.StatusNotFound {
				t.Fatalf("non-member download: %d %s", w.Code, w.Body.String())
			}
			for _, lineage := range []string{"root", "delegation", "retry", "deleted-parent"} {
				t.Run(lineage, func(t *testing.T) {
					f := externalPolicyFixtureForGrantor(t, lineage, grantor)
					missing := request(f.token, uuid.NewString(), "download", otherWorkspace)
					// Verify every expectation queued so far is consumed, so the
					// pending-expectation check below can only refer to the warm
					// entry (ClearExpect would drop the earlier ones unverified).
					if err := cache.ExpectationsWereMet(); err != nil {
						t.Fatal(err)
					}
					// Warm the grantor's membership key for the attachment's own
					// workspace BEFORE the out-of-bounds request: the token's
					// workspace filter must reject the request without ever
					// consulting this cache entry (OL-964, review mutation 11).
					cache.ExpectGet(memberKey).SetVal("1")
					foreign := request(f.token, attachments[otherWorkspace], "download", otherWorkspace)
					if missing.Code != http.StatusNotFound || foreign.Code != missing.Code ||
						foreign.Body.String() != missing.Body.String() ||
						foreign.Header().Get("Content-Type") != missing.Header().Get("Content-Type") ||
						foreign.Header().Get("Location") != "" || foreign.Header().Get("Content-Disposition") != "" {
						t.Fatalf("foreign attachment must look missing: foreign=%d %s missing=%d %s",
							foreign.Code, foreign.Body.String(), missing.Code, missing.Body.String())
					}
					if err := cache.ExpectationsWereMet(); err == nil {
						t.Fatal("warm membership cache was consulted before the workspace filter rejected the request")
					}
					cache.ClearExpect()
					cache.ExpectGet("mul:auth:member:" + grantor + ":" + testWorkspaceID).SetVal("1")
					assertDownload(t, request(f.token, attachments[testWorkspaceID], "download", otherWorkspace), testWorkspaceID)
					for _, attachment := range attachments {
						if w := request(f.token, attachment, "download-metadata", otherWorkspace); w.Code != http.StatusForbidden ||
							!strings.Contains(w.Body.String(), `"code":"external_conversation_forbidden"`) {
							t.Fatalf("external download metadata: %d %s", w.Code, w.Body.String())
						}
					}
				})
			}
			// First-party task credentials retain the upstream cross-workspace
			// download contract; only external conversation authority is narrowed.
			f := newExternalPolicyFixture(t, "root")
			task := fx.Task(t, f.agent, testutil.Cols{
				"runtime_id": f.runtime, "status": "running", "originator_source": "direct_human",
				"originator_user_id": grantor, "accountable_user_id": grantor,
			})
			token := mintAgentTaskToken(t, f.agent, task, grantor)
			cache.ExpectGet(memberKey).SetVal("1")
			assertDownload(t, request(token, attachments[otherWorkspace], "download", testWorkspaceID), otherWorkspace)
			if err := cache.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
