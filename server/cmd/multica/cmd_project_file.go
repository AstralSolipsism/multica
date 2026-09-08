package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func init() { projectCmd.AddCommand(newProjectFileCmd()) }

func newProjectFileCmd() *cobra.Command {
	root := &cobra.Command{Use: "file", Short: "Read and save shared project files with revision protection", Long: "Shared project files use the authenticated business API. Start with capabilities and list; content is fetched on demand. Writes require a new local --request-file, saved before sending. Retry that snapshot after an uncertain result. JSON is always written to stdout; conflict exits 6, pending/unconfirmed exits 7. See each command's --help."}
	root.PersistentFlags().String("output", "json", "Output format (json only; downloads write bytes to --to-file)")
	for _, spec := range []struct {
		name, use, help string
		argc            int
	}{
		{"capabilities", "capabilities <project-id>", "Check API availability, read-only mode and limits", 1},
		{"list", "list <project-id>", "List one page of file metadata without content", 1},
		{"read", "read <project-id> <path>", "Download verified content to a new local file; JSON reports the exact revision read", 2},
		{"save", "save <project-id> <path>", "Save a local draft against --base-revision (0 creates); preserve a request snapshot first", 2},
		{"candidates", "candidates <project-id> <path>", "List one page of unresolved candidate metadata", 2},
		{"candidate", "candidate <project-id> <candidate-id>", "Download verified candidate bytes, including after resolution", 2},
		{"adopt", "adopt <project-id> <path> <candidate-id>", "Adopt a candidate against the revision observed when making this decision", 3},
		{"operation", "operation <project-id> <operation-id>", "Query this actor's operation once; PENDING/absence is not proof of failure", 2},
		{"retry", "retry <request-file>", "Resend a saved request unchanged using the same server, workspace and credential", 1},
	} {
		name, argc := spec.name, spec.argc
		cmd := &cobra.Command{Use: spec.use, Short: spec.help}
		cmd.RunE = func(cmd *cobra.Command, args []string) error {
			var raw any
			var requestFile, operationID string
			var err error
			if len(args) != argc {
				err = projectFileValidation(fmt.Sprintf("expected %d arguments; see --help", argc))
			} else {
				raw, requestFile, operationID, err = executeProjectFile(cmd, args, name)
			}
			if raw != nil {
				if printErr := cli.PrintJSON(cmd.OutOrStdout(), raw); printErr != nil {
					return printErr
				}
			} else if err != nil {
				code, state := "CLIENT_ERROR", "FAILED"
				var feature *cli.ProjectFileError
				var httpErr *cli.HTTPError
				if errors.As(err, &feature) {
					code = feature.Code
				}
				if errors.As(err, &httpErr) {
					var e struct {
						Code string `json:"code"`
					}
					_ = json.Unmarshal([]byte(httpErr.Body), &e)
					code = e.Code
					if code == "" {
						code = "HTTP_" + strconv.Itoa(httpErr.StatusCode)
					}
				}
				if operationID != "" && (requestFile != "" || name == "operation") {
					state = "UNCONFIRMED"
				}
				out := map[string]any{"state": state, "code": code, "error": cli.FormatError(err, false)}
				if operationID != "" {
					out["operation_id"] = operationID
				}
				if requestFile != "" {
					out["request_file"] = requestFile
				}
				if printErr := cli.PrintJSON(cmd.OutOrStdout(), out); printErr != nil {
					return printErr
				}
			}
			return err
		}
		switch name {
		case "list", "candidates":
			cmd.Flags().String("after", "", "Cursor from the previous page (same prefix/path)")
			cmd.Flags().Int("limit", 50, "Page size, 1–200")
			if name == "list" {
				cmd.Flags().String("prefix", "", "Literal path prefix")
			}
		case "read", "candidate":
			cmd.Flags().String("to-file", "", "New local destination (required; refuses overwrite)")
			if name == "read" {
				cmd.Flags().Int64("revision", 0, "Specific historical revision (default: current)")
			}
		case "save", "adopt":
			cmd.Flags().String("operation-id", "", "New decision ID (default: generate a UUID); retry uses the saved ID")
			cmd.Flags().String("request-file", "", "New private JSON snapshot path (required; contains draft bytes, never credentials)")
			if name == "save" {
				cmd.Flags().String("from-file", "", "Local draft file (required, up to 64 MiB)")
				cmd.Flags().Int64("base-revision", 0, "Revision actually read before editing (required; 0 creates)")
				cmd.Flags().String("content-type", "application/octet-stream", "Content type; retained unchanged on retry")
			} else {
				cmd.Flags().Int64("expected-revision", 0, "Revision observed when deciding to adopt (required)")
			}
		}
		root.AddCommand(cmd)
	}
	return root
}

func projectFileValidation(msg string) error {
	return &cli.ProjectFileError{Code: "INVALID_REQUEST", Message: msg, Exit: cli.ExitValidation}
}

type projectFileSnapshot struct {
	Version     int    `json:"snapshot_version"`
	ServerURL   string `json:"server_url"`
	WorkspaceID string `json:"workspace_id"`
	// A one-way binding prevents a request from becoming a new actor's write
	// when a workdir is reused by a later run. Raw tokens are never persisted.
	CredentialSHA256 string                 `json:"credential_sha256"`
	RequestSHA256    string                 `json:"request_sha256"`
	Request          cli.ProjectFileRequest `json:"request"`
}

func executeProjectFile(cmd *cobra.Command, args []string, action string) (any, string, string, error) {
	output, _ := cmd.Flags().GetString("output")
	if output != "json" {
		return nil, "", "", projectFileValidation("project file commands support --output json only")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return nil, "", "", err
	}
	if client.Token == "" || client.WorkspaceID == "" {
		return nil, "", "", projectFileValidation("shared files require an explicit workspace and authenticated credential")
	}
	serverURL, err := url.Parse(client.BaseURL)
	if err != nil || serverURL.User != nil || serverURL.RawQuery != "" || serverURL.Fragment != "" || serverURL.Host == "" || (serverURL.Scheme != "http" && serverURL.Scheme != "https") {
		return nil, "", "", projectFileValidation("invalid API server URL")
	}
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	if action == "retry" {
		snapshot, err := readProjectFileSnapshot(args[0])
		if err != nil {
			return nil, args[0], "", err
		}
		id := snapshot.Request.OperationID
		if snapshot.ServerURL != client.BaseURL || snapshot.WorkspaceID != client.WorkspaceID || snapshot.CredentialSHA256 != projectFileCredentialBinding(client) {
			return nil, args[0], id, projectFileValidation("request belongs to a different server, workspace or credential; do not replay it as another run/member")
		}
		raw, err := client.MutateProjectFile(ctx, snapshot.Request)
		return projectFileRaw(raw), args[0], id, projectFileMutationError(err, args[0], id)
	}
	base, err := cli.ProjectFilesPath(args[0])
	if err != nil {
		return nil, "", "", err
	}
	query := make(url.Values)
	switch action {
	case "capabilities":
		raw, err := client.ProjectFileJSON(ctx, base+"/capabilities", action, "")
		return projectFileRaw(raw), "", "", err
	case "list", "candidates":
		limit, _ := cmd.Flags().GetInt("limit")
		if limit < 1 || limit > 200 {
			return nil, "", "", projectFileValidation("limit must be between 1 and 200")
		}
		after, _ := cmd.Flags().GetString("after")
		query.Set("limit", strconv.Itoa(limit))
		if after != "" {
			query.Set("after", after)
		}
		if action == "candidates" {
			if err := cli.ValidateProjectFilePath(args[1]); err != nil {
				return nil, "", "", err
			}
			query.Set("path", args[1])
			base += "/candidates"
		} else {
			prefix, _ := cmd.Flags().GetString("prefix")
			if prefix != "" {
				query.Set("prefix", prefix)
			}
		}
		raw, err := client.ProjectFileJSON(ctx, base+"?"+query.Encode(), action, "")
		return projectFileRaw(raw), "", "", err
	case "operation":
		if err := cli.ValidateProjectFileOperationID(args[1]); err != nil {
			return nil, "", "", err
		}
		raw, err := client.ProjectFileJSON(ctx, base+"/operations/"+url.PathEscape(args[1]), action, args[1])
		return projectFileRaw(raw), "", args[1], err
	case "read", "candidate":
		return readProjectFileCommand(ctx, cmd, client, base, action, args[1])
	case "save", "adopt":
		r := cli.ProjectFileRequest{Kind: action, ProjectID: strings.TrimSuffix(strings.TrimPrefix(base, "/api/projects/"), "/files"), Path: args[1]}
		r.OperationID, _ = cmd.Flags().GetString("operation-id")
		if r.OperationID == "" {
			r.OperationID = uuid.NewString()
		}
		requestFile, _ := cmd.Flags().GetString("request-file")
		if requestFile == "" {
			return nil, "", r.OperationID, projectFileValidation("--request-file is required; use a new path for each new decision")
		}
		revisionFlag := "base-revision"
		if action == "adopt" {
			revisionFlag = "expected-revision"
			id, err := uuid.Parse(args[2])
			if err != nil {
				return nil, "", r.OperationID, projectFileValidation("candidate-id must be a UUID")
			}
			r.CandidateID = id.String()
		}
		if !cmd.Flags().Changed(revisionFlag) {
			return nil, "", r.OperationID, projectFileValidation("--" + revisionFlag + " is required; never infer it from the latest head")
		}
		r.BaseRevision, _ = cmd.Flags().GetInt64(revisionFlag)
		if action == "save" {
			r.ContentType, _ = cmd.Flags().GetString("content-type")
			source, _ := cmd.Flags().GetString("from-file")
			if source == "" {
				return nil, "", r.OperationID, projectFileValidation("--from-file is required")
			}
			r.Data, err = readProjectFileBounded(source, cli.ProjectFileMaxBytes)
			if err != nil {
				return nil, "", r.OperationID, err
			}
			r.SHA256 = fmt.Sprintf("%x", sha256.Sum256(r.Data))
		}
		if err := r.Validate(); err != nil {
			return nil, "", r.OperationID, err
		}
		snapshot := projectFileSnapshot{Version: 1, ServerURL: client.BaseURL, WorkspaceID: client.WorkspaceID, CredentialSHA256: projectFileCredentialBinding(client), Request: r}
		snapshot.RequestSHA256 = projectFileRequestDigest(r)
		data, err := json.Marshal(snapshot)
		if err != nil {
			return nil, "", r.OperationID, err
		}
		if err := writeProjectFileExclusive(requestFile, data); err != nil {
			return nil, "", r.OperationID, fmt.Errorf("snapshot not saved; no API mutation sent: %w", err)
		}
		fmt.Fprintf(cmd.ErrOrStderr(), "Request %s preserved in %s. Keep this file for operation lookup/retry.\n", r.OperationID, requestFile)
		raw, err := client.MutateProjectFile(ctx, r)
		return projectFileRaw(raw), requestFile, r.OperationID, projectFileMutationError(err, requestFile, r.OperationID)
	}
	return nil, "", "", projectFileValidation("unknown project file command")
}

func projectFileRaw(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func projectFileCredentialBinding(client *cli.APIClient) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(client.Token)))
}

func projectFileRequestDigest(request cli.ProjectFileRequest) string {
	data, _ := json.Marshal(request)
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func projectFileMutationError(err error, snapshot, id string) error {
	if err == nil || cli.ExitCodeFor(err) == cli.ExitFileConflict {
		return err
	}
	message := cli.FormatError(err, false)
	var httpErr *cli.HTTPError
	if errors.As(err, &httpErr) && httpErr.StatusCode >= 500 {
		err = &cli.ProjectFileError{Code: "OUTCOME_UNCONFIRMED", Message: message, Exit: cli.ExitFileUnconfirmed, Err: err}
	}
	return cli.WithUserMessage(message+fmt.Sprintf(" Request %s remains in %s; no save confirmation. Query this operation before retrying the snapshot unchanged. After 401/403, stop; never switch to another actor's credential. For 202/503 wait at least one second.", id, snapshot), err)
}

func readProjectFileBounded(path string, limit int64) ([]byte, error) {
	// Reject pipes/devices before opening: opening a FIFO can itself block.
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, projectFileValidation("input must be a regular file within the CLI size limit")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, projectFileValidation("input must be a regular file within the CLI size limit")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, projectFileValidation("input exceeds the CLI size limit")
	}
	return data, nil
}

func readProjectFileSnapshot(path string) (projectFileSnapshot, error) {
	var snapshot projectFileSnapshot
	data, err := readProjectFileBounded(path, cli.ProjectFileMaxBytes*4/3+(1<<20))
	if err != nil {
		return snapshot, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return snapshot, projectFileValidation("invalid request snapshot: " + err.Error())
	}
	if decoder.Decode(new(any)) != io.EOF || snapshot.Version != 1 {
		return snapshot, projectFileValidation("invalid request snapshot version or trailing data")
	}
	if snapshot.RequestSHA256 != projectFileRequestDigest(snapshot.Request) {
		return snapshot, projectFileValidation("request snapshot was edited; retry must retain the original operation, revision, target and bytes")
	}
	return snapshot, snapshot.Request.Validate()
}

// Publish a completely written private file without clobbering a draft,
// symlink, or earlier snapshot. A failed write never publishes partial bytes.
func writeProjectFileExclusive(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".project-file-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Link(f.Name(), path); err != nil {
		return fmt.Errorf("publish %s (destination must be new and filesystem must support hard links): %w", path, err)
	}
	return nil
}

func readProjectFileCommand(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, action, argument string) (any, string, string, error) {
	destination, _ := cmd.Flags().GetString("to-file")
	if destination == "" {
		return nil, "", "", projectFileValidation("--to-file is required; use a new local path")
	}
	if _, err := os.Lstat(destination); err == nil {
		return nil, "", "", projectFileValidation("destination already exists; choose a new path to preserve your working copy")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", "", err
	}
	query, candidateID := make(url.Values), ""
	var revision *int64
	if action == "read" {
		if err := cli.ValidateProjectFilePath(argument); err != nil {
			return nil, "", "", err
		}
		query.Set("path", argument)
		if cmd.Flags().Changed("revision") {
			n, _ := cmd.Flags().GetInt64("revision")
			if n < 1 || n > cli.ProjectFileMaxRevision+1 {
				return nil, "", "", projectFileValidation("revision must be a positive supported revision")
			}
			revision = &n
			query.Set("revision", strconv.FormatInt(n, 10))
		}
		base += "/content?" + query.Encode()
	} else {
		id, err := uuid.Parse(argument)
		if err != nil {
			return nil, "", "", projectFileValidation("candidate-id must be a UUID")
		}
		candidateID = id.String()
		base += "/candidates/" + candidateID + "/content"
	}
	meta, data, err := client.DownloadProjectFile(ctx, base, candidateID, revision)
	if err != nil {
		return nil, "", "", err
	}
	if err := writeProjectFileExclusive(destination, data); err != nil {
		return nil, "", "", err
	}
	return struct {
		cli.ProjectFileDownload
		LocalFile string `json:"local_file"`
	}{meta, destination}, "", "", nil
}
