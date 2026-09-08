// Package projectfile owns project file authorization, immutable content and
// atomic revision/candidate/operation commits. All callers use this service.
package projectfile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
)

var (
	ErrForbidden       = errors.New("project file access denied")
	ErrNotFound        = errors.New("project file or candidate not found")
	ErrOpKeyReused     = errors.New("operation key is bound to a different request")
	ErrReadOnly        = errors.New("project files are read-only")
	ErrInvalid         = errors.New("invalid project file request")
	ErrContentMismatch = errors.New("content length or SHA-256 does not match")
	ErrTooLarge        = errors.New("file exceeds the upload limit")
	ErrPathCollision   = errors.New("a file occupies an ancestor or descendant path")
	ErrStorage         = errors.New("project file storage is unavailable")
	ErrOutcomeUnknown  = errors.New("operation outcome is unknown; query or retry the original operation")
)

const (
	StatusSaved           = "SAVED"
	StatusConflict        = "CONFLICT"
	DefaultMaxBytes int64 = 64 << 20
	MaxRevision     int64 = 1<<53 - 2
)

// Scope contains only server-authenticated identity and resolved UUIDs.
type Scope struct {
	WorkspaceID pgtype.UUID
	ProjectID   pgtype.UUID
	Identity    auth.Identity
}

// Request is the complete durable binding. CandidateID remains in the binding
// for successful adoption, even though SAVED results never expose CandidateID.
type Request struct {
	Kind         string `json:"kind"`
	Path         string `json:"path"`
	BaseRevision int64  `json:"base_revision"`
	SHA256       string `json:"sha256,omitempty"`
	SizeBytes    int64  `json:"size_bytes"`
	ContentType  string `json:"content_type,omitempty"`
	CandidateID  string `json:"candidate_id,omitempty"`
}

type Result struct {
	OperationID     string `json:"operation_id"`
	Status          string `json:"status"`
	FileID          string `json:"file_id"`
	Path            string `json:"path"`
	BaseRevision    int64  `json:"base_revision"`
	Revision        int64  `json:"revision"`
	VersionID       string `json:"version_id"`
	CandidateID     string `json:"candidate_id,omitempty"`
	ConflictCurrent int64  `json:"conflict_current,omitempty"`
	Replayed        bool   `json:"replayed"`
}

type Operation struct {
	State       string  `json:"state"`
	OperationID string  `json:"operation_id"`
	Result      *Result `json:"result,omitempty"`
}

type File struct {
	FileID       string    `json:"file_id"`
	Path         string    `json:"path"`
	Revision     int64     `json:"revision"`
	BaseRevision int64     `json:"base_revision"`
	VersionID    string    `json:"version_id"`
	CandidateID  string    `json:"candidate_id,omitempty"`
	SizeBytes    int64     `json:"size_bytes"`
	SHA256       string    `json:"sha256"`
	ContentType  string    `json:"content_type"`
	AuthorType   string    `json:"author_type"`
	AuthorID     string    `json:"author_id"`
	SourceTaskID string    `json:"source_task_id,omitempty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Page struct {
	Files      []File `json:"files"`
	NextCursor string `json:"next_cursor,omitempty"`
}

type Objects interface {
	Put(context.Context, string, io.Reader, int64, string) error
	Open(context.Context, string) (io.ReadCloser, error)
}

type Options struct {
	ReadOnly      bool
	MaxBytes      int64
	UploadTimeout time.Duration
	CommitTimeout time.Duration
}

var operationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func ValidOperationKey(key string) bool { return operationKeyPattern.MatchString(key) }

// Paths are relative logical addresses. Reject ambiguous paths instead of
// silently cleaning them into a different target or request binding.
func ValidatePath(path string) error {
	if path == "" || len(path) > 1024 || !utf8.ValidString(path) || strings.Contains(path, "\\") {
		return ErrInvalid
	}
	for _, r := range path {
		if unicode.IsControl(r) {
			return ErrInvalid
		}
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." || len(segment) > 255 {
			return ErrInvalid
		}
	}
	return nil
}

func (r Request) validate(key string, maxBytes int64) error {
	if !ValidOperationKey(key) || ValidatePath(r.Path) != nil || r.BaseRevision < 0 || r.BaseRevision > MaxRevision {
		return ErrInvalid
	}
	switch r.Kind {
	case "save":
		media, _, err := mime.ParseMediaType(r.ContentType)
		if err != nil || media == "" || len(r.ContentType) > 255 || strings.ContainsAny(r.ContentType, "\r\n") || !digestPattern.MatchString(r.SHA256) || r.SizeBytes < 0 || r.CandidateID != "" {
			return ErrInvalid
		}
		if r.SizeBytes > maxBytes {
			return ErrTooLarge
		}
	case "adopt":
		var id pgtype.UUID
		if id.Scan(r.CandidateID) != nil || !id.Valid || r.SHA256 != "" || r.ContentType != "" || r.SizeBytes != 0 {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}

func changedOne(n int64, err error) error {
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("project file invariant: expected one affected row, got %d", n)
	}
	return nil
}
