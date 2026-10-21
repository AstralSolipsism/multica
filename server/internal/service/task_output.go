package service

import (
	"strings"

	"github.com/multica-ai/multica/server/internal/util"
)

// normalizeTaskOutput repairs wholly escaped stdout, but never reinterprets
// backslashes in already-decoded multiline output from an agent.
func normalizeTaskOutput(output string) string {
	if strings.ContainsAny(output, "\r\n") {
		return output
	}
	return util.UnescapeBackslashEscapes(output)
}
