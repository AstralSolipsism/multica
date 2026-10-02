package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestExternalConversationPolicyUsesResolvedRoute(t *testing.T) {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allowExternalConversationRequest(r) {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	})
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }
	router.Route("/api/issues", func(r chi.Router) {
		r.Get("/", ok)
		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", func(w http.ResponseWriter, r *http.Request) {
				if chi.URLParam(r, "id") != "sample" {
					t.Errorf("authorization changed downstream parameters: %q", chi.URLParam(r, "id"))
				}
				ok(w, r)
			})
			r.Post("/comments", ok)
			r.Post("/wakeups", ok)
		})
		// A newly introduced literal route must not borrow the {id} grant.
		r.Get("/future-secret", ok)
		r.Post("/future-action", ok)
	})
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/api/issues", 204}, {"GET", "/api/issues/", 204},
		{"GET", "/api/issues/sample", 204}, {"GET", "/api/issues/sample/", 204},
		{"POST", "/api/issues/sample/comments?workspace_id=forged", 204},
		{"POST", "/api/issues/sample/wakeups", 403},
		{"GET", "/api/issues/future-secret", 403}, {"POST", "/api/issues/future-action", 403},
		{"HEAD", "/api/issues/sample", 403}, {"DELETE", "/api/issues/sample", 403},
		{"GET", "/api/issues//future-secret", 403},
		{"GET", "/api/issues/sample/../../tokens", 403},
		{"GET", "/api/issues/sample/%2e%2e/tokens", 403},
		{"POST", "/api/issues/sample/comments/../wakeups", 403},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
		})
	}
	if allowExternalConversationRequest(httptest.NewRequest("GET", "/api/issues", nil)) {
		t.Fatal("missing production routing context must fail closed")
	}
}
