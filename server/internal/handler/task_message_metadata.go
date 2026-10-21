package handler

import (
	"bytes"
	"encoding/json"
	"log/slog"

	"github.com/multica-ai/multica/server/internal/util"
)

const maxTaskMessageMetadataBytes = 4 * 1024

// Empty string is SQL NULL in the batch insert. Optional metadata must never
// prevent the rest of a transcript from being persisted.
func taskMessageMetadata(raw json.RawMessage, taskID string, seq int) string {
	if len(raw) == 0 {
		return ""
	}
	drop := func(reason string) string {
		slog.Warn("discarding task message metadata", "task_id", taskID, "seq", seq, "reason", reason, "bytes", len(raw))
		return ""
	}
	if len(raw) > maxTaskMessageMetadataBytes {
		return drop("exceeds 4KB")
	}
	var metadata map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&metadata); err != nil || metadata == nil {
		return drop("expected JSON object")
	}
	// JSON permits escaped NULs, but PostgreSQL JSONB does not.
	encoded, err := json.Marshal(util.SanitizeJSONForPostgres(metadata))
	if err != nil {
		return drop("invalid JSON object")
	}
	if len(encoded) > maxTaskMessageMetadataBytes {
		return drop("exceeds 4KB after encoding")
	}
	return string(encoded)
}
