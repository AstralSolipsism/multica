package middleware

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Preserve the baseline decision error contract when Auth rejects the workspace
// selector before the handler can classify the task credential.
func writeLabrastroBaselineCredentialDenied(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if r.Method != http.MethodPost || len(parts) != 5 || parts[0] != "api" || parts[1] != "projects" || parts[2] == "" || parts[3] != "baseline" || parts[4] != "decisions" {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "baseline credential denied", "code": "baseline_credential_denied"})
	return true
}
