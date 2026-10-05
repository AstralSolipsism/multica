package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// External requests execute as the frozen grantor, never the runtime owner
// stored on the token. Ordinary task credentials retain their original user.
func conversationTaskUser(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, workspaceID pgtype.UUID, tokenUser string) (string, error) {
	subject, err := channel.AuthorizeConversationTask(ctx, q, task, workspaceID)
	if err != nil {
		return "", err
	}
	if subject.UserID.Valid {
		return uuidToString(subject.UserID), nil
	}
	return tokenUser, nil
}

// External conversations may use issue collaboration, not the runtime owner's
// account or durable configuration. Match the PRODUCTION route template, never
// a URL prefix: a new /issues/export-credentials route must not inherit {id}'s
// permission. Missing routing context, new routes and new methods fail closed.
// Normal member credentials and first-party task tokens do not use this policy.
func allowExternalConversationRequest(r *http.Request) bool {
	route := chi.RouteContext(r.Context())
	if route == nil || route.Routes == nil {
		return false
	}
	path := r.URL.RawPath
	if path == "" {
		path = r.URL.Path
	}
	pattern := route.Routes.Find(chi.NewRouteContext(), r.Method, path)
	return ExternalConversationRouteAllowed(r.Method, pattern)
}

// ExternalConversationRouteAllowed is also used by the production-route
// inventory test. That test records the decision for every route so an upstream
// addition requires an explicit review, even though it is already denied here.
func ExternalConversationRouteAllowed(method, pattern string) bool {
	_, ok := externalConversationRoutes[method+" "+strings.TrimSuffix(pattern, "/")]
	return ok
}

var externalConversationRoutes = map[string]struct{}{
	// Read issue content and the workspace catalogs needed to address an issue.
	"GET /api/issues":                                {},
	"GET /api/issues/search":                         {},
	"GET /api/issues/children":                       {},
	"GET /api/issues/child-progress":                 {},
	"GET /api/issues/grouped":                        {},
	"GET /api/issues/{id}":                           {},
	"GET /api/issues/{id}/comments":                  {},
	"GET /api/issues/{id}/timeline":                  {},
	"GET /api/issues/{id}/dependencies":              {},
	"GET /api/issues/{id}/children":                  {},
	"GET /api/issues/{id}/duplicates":                {},
	"GET /api/issues/{id}/labels":                    {},
	"GET /api/issues/{id}/metadata":                  {},
	"GET /api/issues/{id}/attachments":               {},
	"GET /api/issues/{id}/task-runs":                 {},
	"GET /api/issues/{id}/active-task":               {},
	"GET /api/tasks/{taskId}/messages":               {},
	"GET /api/agents":                                {},
	"GET /api/agents/{id}":                           {},
	"GET /api/agents/{id}/skills":                    {},
	"GET /api/skills":                                {},
	"GET /api/skills/{id}":                           {},
	"GET /api/skills/{id}/files":                     {},
	"GET /api/projects":                              {},
	"GET /api/projects/search":                       {},
	"GET /api/projects/{id}":                         {},
	"GET /api/projects/{id}/resources":               {},
	"GET /api/labels":                                {},
	"GET /api/labels/{id}":                           {},
	"GET /api/issue-statuses":                        {},
	"GET /api/properties":                            {},
	"GET /api/properties/{id}":                       {},
	"GET /api/workspaces/{id}/members":               {},
	"GET /api/workspaces/{workspaceId}/issues/graph": {},
	"GET /api/attachments/{id}":                      {},
	"GET /api/attachments/{id}/content":              {},
	"GET /api/attachments/{id}/download":             {},

	// QueryIssues is the POST form of the read-only issue list.
	"POST /api/issues/query": {},
	// Assignment/delegation still uses the existing invocation and ancestry
	// checks in the issue/comment handlers; this allowlist grants no new rights.
	"POST /api/issues":                                {},
	"POST /api/issues/with-dependencies":              {},
	"PUT /api/issues/{id}":                            {},
	"PATCH /api/issues/{id}/with-dependencies":        {},
	"POST /api/issues/{id}/comments":                  {},
	"PUT /api/comments/{commentId}":                   {},
	"DELETE /api/comments/{commentId}":                {},
	"DELETE /api/comments/{commentId}/keep-replies":   {},
	"POST /api/comments/{commentId}/resolve":          {},
	"DELETE /api/comments/{commentId}/resolve":        {},
	"POST /api/comments/{commentId}/reactions":        {},
	"DELETE /api/comments/{commentId}/reactions":      {},
	"POST /api/issues/{id}/reactions":                 {},
	"DELETE /api/issues/{id}/reactions":               {},
	"POST /api/issues/{id}/labels":                    {},
	"DELETE /api/issues/{id}/labels/{labelId}":        {},
	"PUT /api/issues/{id}/metadata/{key}":             {},
	"DELETE /api/issues/{id}/metadata/{key}":          {},
	"PUT /api/issues/{id}/properties/{propertyId}":    {},
	"DELETE /api/issues/{id}/properties/{propertyId}": {},
	"POST /api/upload-file":                           {},
	"DELETE /api/attachments/{id}":                    {},
}
