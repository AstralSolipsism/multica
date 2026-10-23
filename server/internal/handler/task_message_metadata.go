package handler

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/redact"
)

const maxTaskMessageMetadataBytes = 4 * 1024

// Combined with the 4KB input cap, this keeps both the integer digits and
// decimal scale well within PostgreSQL numeric limits, even for zero values.
const maxTaskMessageMetadataExponent = 1000

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
	if !taskMessageMetadataNumbersSafe(metadata) {
		return drop("numeric exponent out of range")
	}
	metadata = redact.InputMap(metadata)
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

func taskMessageMetadataNumbersSafe(value any) bool {
	switch value := value.(type) {
	case json.Number:
		literal := value.String()
		if i := strings.IndexAny(literal, "eE"); i >= 0 {
			// Check the literal exponent: ParseFloat silently rounds extreme
			// negative exponents to zero, while PostgreSQL rejects their scale.
			exponent, err := strconv.ParseInt(literal[i+1:], 10, 32)
			return err == nil && exponent >= -maxTaskMessageMetadataExponent && exponent <= maxTaskMessageMetadataExponent
		}
	case map[string]any:
		for _, child := range value {
			if !taskMessageMetadataNumbersSafe(child) {
				return false
			}
		}
	case []any:
		for _, child := range value {
			if !taskMessageMetadataNumbersSafe(child) {
				return false
			}
		}
	}
	return true
}
