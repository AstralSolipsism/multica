package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

// The client bounds local snapshots independently of the server's upload limit.
const ProjectFileMaxBytes int64 = 64 << 20
const ProjectFileMaxRevision int64 = 1<<53 - 2
const ExitFileConflict = 6
const ExitFileUnconfirmed = 7

var fileOperationKey = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var fileDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ProjectFileError preserves feature-specific semantics through main's error
// formatter without changing the exit contract of unrelated CLI commands.
type ProjectFileError struct {
	Code    string
	Message string
	Exit    int
	Err     error
}

func (e *ProjectFileError) Error() string { return e.Message }
func (e *ProjectFileError) Unwrap() error { return e.Err }

func fileInvalid(message string) error {
	return &ProjectFileError{Code: "INVALID_REQUEST", Message: message, Exit: ExitValidation}
}

func fileUnconfirmed(message string) error {
	return &ProjectFileError{Code: "UNCONFIRMED_RESPONSE", Message: message + "; keep the original request and query its operation before retrying unchanged", Exit: ExitFileUnconfirmed}
}

func ValidateProjectFilePath(path string) error {
	if path == "" || len(path) > 1024 || !utf8.ValidString(path) || strings.Contains(path, `\`) {
		return fileInvalid("path must be a relative UTF-8 logical file path (up to 1024 bytes)")
	}
	for _, r := range path {
		if unicode.IsControl(r) {
			return fileInvalid("file paths cannot contain control characters")
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return fileInvalid("file paths cannot contain empty, dot, parent, or oversized segments")
		}
	}
	return nil
}

func ProjectFilesPath(project string) (string, error) {
	id, err := uuid.Parse(project)
	if err != nil {
		return "", fileInvalid("project-id must be a UUID from the task brief or project list")
	}
	return "/api/projects/" + id.String() + "/files", nil
}

func ValidateProjectFileOperationID(id string) error {
	if !fileOperationKey.MatchString(id) {
		return fileInvalid("operation-id must contain 1–128 ASCII letters, digits, dots, underscores, colons or hyphens")
	}
	return nil
}

// ProjectFileRequest is a credential-free snapshot of a mutation. Data belongs
// to this decision, not to a mutable working file. Retry sends it verbatim.
type ProjectFileRequest struct {
	OperationID  string `json:"operation_id"`
	ProjectID    string `json:"project_id"`
	Kind         string `json:"kind"`
	Path         string `json:"path"`
	BaseRevision int64  `json:"base_revision"`
	CandidateID  string `json:"candidate_id,omitempty"`
	ContentType  string `json:"content_type,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
	Data         []byte `json:"data,omitempty"`
}

func (r ProjectFileRequest) Validate() error {
	if _, err := ProjectFilesPath(r.ProjectID); err != nil {
		return err
	}
	if err := ValidateProjectFileOperationID(r.OperationID); err != nil {
		return err
	}
	if err := ValidateProjectFilePath(r.Path); err != nil {
		return err
	}
	if r.BaseRevision < 0 || r.BaseRevision > ProjectFileMaxRevision {
		return fileInvalid("base/expected revision is out of range")
	}
	switch r.Kind {
	case "save":
		if int64(len(r.Data)) > ProjectFileMaxBytes {
			return fileInvalid("CLI file limit is 64 MiB")
		}
		if r.CandidateID != "" || !fileDigest.MatchString(r.SHA256) || r.SHA256 != fmt.Sprintf("%x", sha256.Sum256(r.Data)) {
			return fileInvalid("request snapshot content digest does not match")
		}
		if _, _, err := mime.ParseMediaType(r.ContentType); err != nil || len(r.ContentType) > 255 || strings.ContainsAny(r.ContentType, "\r\n") {
			return fileInvalid("invalid content-type")
		}
	case "adopt":
		if _, err := uuid.Parse(r.CandidateID); err != nil || len(r.Data) != 0 || r.ContentType != "" || r.SHA256 != "" {
			return fileInvalid("invalid candidate adoption request")
		}
	default:
		return fileInvalid("unknown project file operation kind")
	}
	return nil
}

// Do not follow redirects to a login page, object URL, or a different scope.
// Writes have no GetBody callback, preventing the transport from replaying an
// idempotency-key request behind the caller's back after a connection failure.
func (c *APIClient) projectFileHTTP(ctx context.Context, method, path string, data []byte, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.GetBody = nil
	c.setHeaders(req)
	req.Header.Set("Accept-Encoding", "identity")
	for key, values := range headers {
		req.Header[key] = values
	}
	client := *c.HTTPClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	return resp, wrapTransport(req, err)
}

func readProjectFileJSON(resp *http.Response) (json.RawMessage, error) {
	data, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil {
		return nil, wrapBodyRead(resp.Request, err)
	}
	if len(data) > 2<<20 || !json.Valid(data) {
		return nil, fileUnconfirmed("invalid or oversized API response")
	}
	return json.RawMessage(data), nil
}

type fileResult struct {
	OperationID     string  `json:"operation_id"`
	Status          string  `json:"status"`
	FileID          string  `json:"file_id"`
	Path            string  `json:"path"`
	BaseRevision    *int64  `json:"base_revision"`
	Revision        *int64  `json:"revision"`
	VersionID       string  `json:"version_id"`
	CandidateID     *string `json:"candidate_id"`
	ConflictCurrent *int64  `json:"conflict_current"`
	Replayed        *bool   `json:"replayed"`
}

func validFileUUID(s string) bool { _, err := uuid.Parse(s); return err == nil }

func validateFileResult(data json.RawMessage, operationID string, request *ProjectFileRequest) (string, error) {
	var r fileResult
	if json.Unmarshal(data, &r) != nil || r.OperationID != operationID || !validFileUUID(r.FileID) || !validFileUUID(r.VersionID) || ValidateProjectFilePath(r.Path) != nil || r.BaseRevision == nil || r.Revision == nil || r.Replayed == nil || *r.BaseRevision < 0 || *r.BaseRevision > ProjectFileMaxRevision || *r.Revision < 0 || *r.Revision > ProjectFileMaxRevision+1 {
		return "", fileUnconfirmed("incomplete mutation result")
	}
	if request != nil && (r.Path != request.Path || *r.BaseRevision != request.BaseRevision) {
		return "", fileUnconfirmed("mutation result does not match the request")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	switch r.Status {
	case "SAVED":
		if *r.Revision != *r.BaseRevision+1 || fields["candidate_id"] != nil || fields["conflict_current"] != nil {
			return "", fileUnconfirmed("inconsistent SAVED result")
		}
	case "CONFLICT":
		if r.CandidateID == nil || !validFileUUID(*r.CandidateID) || r.ConflictCurrent == nil || *r.ConflictCurrent != *r.Revision {
			return "", fileUnconfirmed("incomplete CONFLICT result")
		}
		if request != nil && request.Kind == "adopt" && *r.CandidateID != request.CandidateID {
			return "", fileUnconfirmed("conflict refers to a different candidate")
		}
	default:
		return "", fileUnconfirmed("unknown mutation result status")
	}
	return r.Status, nil
}

func fileResultError(status string) error {
	if status == "CONFLICT" {
		return &ProjectFileError{Code: "CONFLICT", Message: "CONFLICT: candidate preserved; current file was not updated. A new adoption decision requires an explicit expected revision and a new operation ID.", Exit: ExitFileConflict}
	}
	return nil
}

func (c *APIClient) MutateProjectFile(ctx context.Context, r ProjectFileRequest) (json.RawMessage, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	base, _ := ProjectFilesPath(r.ProjectID)
	headers := make(http.Header)
	headers.Set("Idempotency-Key", r.OperationID)
	method, path, data := http.MethodPut, base+"/content?"+url.Values{"path": {r.Path}}.Encode(), r.Data
	if r.Kind == "save" {
		headers.Set("X-Base-Revision", strconv.FormatInt(r.BaseRevision, 10))
		headers.Set("X-Content-SHA256", r.SHA256)
		headers.Set("Content-Type", r.ContentType)
	} else {
		method, path = http.MethodPost, base+"/candidates/"+r.CandidateID+"/adopt"
		data, _ = json.Marshal(struct {
			Path             string `json:"path"`
			ExpectedRevision int64  `json:"expected_revision"`
		}{r.Path, r.BaseRevision})
		headers.Set("Content-Type", "application/json")
	}
	resp, err := c.projectFileHTTP(ctx, method, path, data, headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 409 {
		if resp.StatusCode < 400 {
			return nil, fileUnconfirmed("mutation did not return a final result")
		}
		return nil, newHTTPError(method, path, resp)
	}
	raw, err := readProjectFileJSON(resp)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 409 {
		var envelope struct {
			Code  string `json:"code"`
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &envelope)
		if envelope.Code != "" || envelope.Error != "" {
			return nil, &HTTPError{Method: method, Path: path, StatusCode: 409, Body: string(raw), TaskScoped: requestUsedTaskToken(resp)}
		}
	}
	status, err := validateFileResult(raw, r.OperationID, &r)
	if err != nil {
		return nil, err
	}
	if (resp.StatusCode == 200) != (status == "SAVED") {
		return nil, fileUnconfirmed("HTTP status disagrees with mutation result")
	}
	return raw, fileResultError(status)
}

// ProjectFileJSON returns one bounded page/capability/operation response. It
// never chases pagination or polls pending operations automatically.
func (c *APIClient) ProjectFileJSON(ctx context.Context, path, kind, operationID string) (json.RawMessage, error) {
	resp, err := c.projectFileHTTP(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && !(kind == "operation" && resp.StatusCode == 202) {
		return nil, newHTTPError(http.MethodGet, path, resp)
	}
	raw, err := readProjectFileJSON(resp)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "operation":
		var op struct {
			State       string          `json:"state"`
			OperationID string          `json:"operation_id"`
			Result      json.RawMessage `json:"result"`
		}
		if json.Unmarshal(raw, &op) != nil || op.OperationID != operationID {
			return nil, fileUnconfirmed("invalid operation response")
		}
		if op.State == "PENDING" && resp.StatusCode == 202 && len(op.Result) == 0 {
			return raw, &ProjectFileError{Code: "PENDING", Message: "PENDING is not confirmation; no worker will finish it automatically. Keep the original request; wait at least one second before querying or retrying unchanged.", Exit: ExitFileUnconfirmed}
		}
		if op.State != "COMPLETED" || resp.StatusCode != 200 {
			return nil, fileUnconfirmed("unconfirmed operation state")
		}
		status, err := validateFileResult(op.Result, operationID, nil)
		if err != nil {
			return nil, err
		}
		return raw, fileResultError(status)
	case "capabilities":
		var caps struct {
			Enabled    *bool `json:"enabled"`
			APIVersion int   `json:"api_version"`
			ReadOnly   *bool `json:"read_only"`
			MaxBytes   int64 `json:"max_file_bytes"`
			MaxPage    int   `json:"max_page_size"`
		}
		if json.Unmarshal(raw, &caps) != nil || caps.Enabled == nil || !*caps.Enabled || caps.APIVersion != 1 || caps.ReadOnly == nil || caps.MaxBytes < 1 || caps.MaxPage < 1 || caps.MaxPage > 200 {
			return nil, fileUnconfirmed("unsupported project file capabilities")
		}
	case "list", "candidates":
		var page struct {
			Files      *[]json.RawMessage `json:"files"`
			NextCursor string             `json:"next_cursor"`
		}
		if json.Unmarshal(raw, &page) != nil || page.Files == nil || len(*page.Files) > 200 {
			return nil, fileUnconfirmed("invalid file page")
		}
		for _, entry := range *page.Files {
			var f struct {
				FileID       string `json:"file_id"`
				Path         string `json:"path"`
				Revision     *int64 `json:"revision"`
				BaseRevision *int64 `json:"base_revision"`
				VersionID    string `json:"version_id"`
				Size         *int64 `json:"size_bytes"`
				SHA256       string `json:"sha256"`
				CandidateID  string `json:"candidate_id"`
			}
			if json.Unmarshal(entry, &f) != nil || !validFileUUID(f.FileID) || !validFileUUID(f.VersionID) || ValidateProjectFilePath(f.Path) != nil || f.Revision == nil || *f.Revision < 0 || f.BaseRevision == nil || *f.BaseRevision < 0 || f.Size == nil || *f.Size < 0 || !fileDigest.MatchString(f.SHA256) || (kind == "candidates" && (!validFileUUID(f.CandidateID) || *f.Revision != 0)) {
				return nil, fileUnconfirmed("invalid file metadata")
			}
		}
	default:
		return nil, fileInvalid("unknown file query")
	}
	return raw, nil
}

type ProjectFileDownload struct {
	FileID       string `json:"file_id"`
	Revision     int64  `json:"revision"`
	BaseRevision int64  `json:"base_revision"`
	VersionID    string `json:"version_id"`
	CandidateID  string `json:"candidate_id,omitempty"`
	SHA256       string `json:"sha256"`
	SizeBytes    int64  `json:"size_bytes"`
	ContentType  string `json:"content_type"`
}

// DownloadProjectFile validates immutable version headers and complete bytes
// before returning them. The command publishes the local copy only afterwards.
func (c *APIClient) DownloadProjectFile(ctx context.Context, path, candidateID string, revision *int64) (ProjectFileDownload, []byte, error) {
	var meta ProjectFileDownload
	resp, err := c.projectFileHTTP(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return meta, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return meta, nil, newHTTPError(http.MethodGet, path, resp)
	}
	meta.FileID, meta.VersionID = resp.Header.Get("X-File-ID"), resp.Header.Get("X-Version-ID")
	meta.SHA256, meta.CandidateID = resp.Header.Get("X-Content-SHA256"), resp.Header.Get("X-Candidate-ID")
	meta.ContentType, meta.SizeBytes = resp.Header.Get("Content-Type"), resp.ContentLength
	meta.Revision, err = strconv.ParseInt(resp.Header.Get("X-Revision"), 10, 64)
	base, baseErr := strconv.ParseInt(resp.Header.Get("X-Base-Revision"), 10, 64)
	meta.BaseRevision = base
	if err != nil || baseErr != nil || base < 0 || base > ProjectFileMaxRevision || meta.Revision < 0 || meta.Revision > ProjectFileMaxRevision+1 || !validFileUUID(meta.FileID) || !validFileUUID(meta.VersionID) || !fileDigest.MatchString(meta.SHA256) || meta.SizeBytes < 0 || meta.SizeBytes > ProjectFileMaxBytes || meta.CandidateID != candidateID || (candidateID != "" && meta.Revision != 0) || (candidateID == "" && meta.Revision < 1) || (revision != nil && *revision != meta.Revision) {
		return meta, nil, fileUnconfirmed("invalid download metadata; local file not changed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, meta.SizeBytes+1))
	if err != nil {
		return meta, nil, wrapBodyRead(resp.Request, err)
	}
	if int64(len(data)) != meta.SizeBytes || fmt.Sprintf("%x", sha256.Sum256(data)) != meta.SHA256 {
		return meta, nil, fileUnconfirmed("download length or SHA-256 mismatch; local file not changed")
	}
	return meta, data, nil
}
