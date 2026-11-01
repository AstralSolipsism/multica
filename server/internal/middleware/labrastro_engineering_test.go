package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestLabrastroBaselineTaskWorkspaceCredentialDenied(t *testing.T) {
	for _, selector := range []struct{ key, value string }{
		{"X-Workspace-ID", ttWorkspaceB},
		{"X-Workspace-Slug", ttSlugB},
	} {
		t.Run(selector.key, func(t *testing.T) {
			handler := Auth(db.New(&fakeTaskTokenDB{t: t}), nil, nil, nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("cross-workspace token reached the baseline handler")
			}))
			req := httptest.NewRequest("POST", "/api/projects/project/baseline/decisions", nil)
			req.Header.Set("Authorization", "Bearer "+ttTestToken)
			req.Header.Set(selector.key, selector.value)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			var body struct{ Code string }
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != 403 || body.Code != "baseline_credential_denied" {
				t.Fatalf("unexpected rejection: %d %s", response.Code, response.Body.String())
			}
		})
	}
}
