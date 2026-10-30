package handler

import (
	"net/http"
	"slices"
	"strings"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func runtimeMediaCapabilities(r *http.Request, provider string, media []string) []string {
	result := make([]string, 0)
	for _, cap := range requestClientCapabilities(r) {
		if !strings.HasPrefix(cap, "media-") {
			result = append(result, cap)
		}
	}
	for _, cap := range media {
		if protocol.ValidMediaTag(provider, cap) && !slices.Contains(result, cap) {
			result = append(result, cap)
		}
	}
	return result
}
