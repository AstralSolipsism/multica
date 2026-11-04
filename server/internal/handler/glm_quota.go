package handler

import (
	"net/http"
)

// Legacy account-level GLM quota endpoint. The server-wide
// GLM_QUOTA_API_KEY monitor was retired in OL-1205 scenario 3 (replaced by
// user-registered quota sources polled per credential); the route stays so
// installed desktop clients keep parsing the response, and always answers
// enabled=false — clients render "not configured".
func (h *Handler) GetGlmQuota(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
}
