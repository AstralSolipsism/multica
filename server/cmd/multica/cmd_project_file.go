package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	"github.com/spf13/pflag"
)

var projectFileCmd = newProjectFileCmd()

func init() { projectCmd.AddCommand(projectFileCmd) }

type projectFileCommandResult struct {
	Value       any
	RequestFile string
	OperationID string
	Unconfirmed bool
}

type projectFileHandler func(context.Context, *cobra.Command, *cli.APIClient, string, []string) (projectFileCommandResult, error)

func newProjectFileCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "file",
		Short: "Read and save shared project files with revision protection",
		Long: `Shared project files use the authenticated business API.
Start with capabilities and list; content is fetched on demand.
Writes require a new local --request-file, saved before sending.
Retry that snapshot after an uncertain result. JSON is always written to stdout;
conflict exits 6, pending/unconfirmed exits 7. See each command's --help.`,
	}
	root.PersistentFlags().String("output", "json", "Output format (json only; downloads write bytes to --to-file)")
	// Keep arguments, flags and handlers together. Each factory call creates
	// independent Cobra flag state, including concurrent command tests.
	for _, spec := range []struct {
		use, help string
		argc      int
		flags     func(*pflag.FlagSet)
		run       projectFileHandler
	}{
		{"capabilities <project-id>", "Check API availability, read-only mode and limits", 1, nil, queryProjectFileCapabilities},
		{"list <project-id>", "List one page of file metadata without content", 1, func(f *pflag.FlagSet) {
			projectFilePageFlags(f)
			f.String("prefix", "", "Literal path prefix")
		}, listProjectFiles},
		{"read <project-id> <path>", "Download verified content to a new local file; JSON reports the exact revision read", 2, func(f *pflag.FlagSet) {
			projectFileDownloadFlags(f)
			f.Int64("revision", 0, "Specific historical revision (default: current)")
		}, readProjectFile},
		{"save <project-id> <path>", "Save a local draft against --base-revision (0 creates); preserve a request snapshot first", 2, func(f *pflag.FlagSet) {
			projectFileMutationFlags(f)
			f.String("from-file", "", "Local draft file (required, up to 64 MiB and the advertised server limit)")
			f.Int64("base-revision", 0, "Revision actually read before editing (required; 0 creates)")
			f.String("content-type", "application/octet-stream", "Content type; retained unchanged on retry")
		}, saveProjectFile},
		{"candidates <project-id> <path>", "List one page of unresolved candidate metadata", 2, projectFilePageFlags, listProjectFileCandidates},
		{"candidate <project-id> <candidate-id>", "Download verified candidate bytes, including after resolution", 2, projectFileDownloadFlags, readProjectFileCandidate},
		{"adopt <project-id> <path> <candidate-id>", "Adopt a candidate against the revision observed when making this decision", 3, func(f *pflag.FlagSet) {
			projectFileMutationFlags(f)
			f.Int64("expected-revision", 0, "Revision observed when deciding to adopt (required)")
		}, adoptProjectFileCandidate},
		{"operation <project-id> <operation-id>", "Query this actor's operation once; PENDING/absence is not proof of failure", 2, nil, queryProjectFileOperation},
		{"retry <request-file>", "Resend a saved request unchanged using the same server, workspace and credential", 1, nil, retryProjectFile},
	} {
		cmd := &cobra.Command{
			Use: spec.use, Short: spec.help,
			Args: projectFileArgs(spec.argc),
			RunE: func(cmd *cobra.Command, args []string) error {
				result, err := executeProjectFile(cmd, args, spec.run)
				return printProjectFileResult(cmd, result, err)
			},
		}
		if spec.flags != nil {
			spec.flags(cmd.Flags())
		}
		root.AddCommand(cmd)
	}
	return root
}

func projectFilePageFlags(f *pflag.FlagSet) {
	f.String("after", "", "Cursor from the previous page (same prefix/path)")
	f.Int("limit", 50, "Page size, 1–200")
}

func projectFileDownloadFlags(f *pflag.FlagSet) {
	f.String("to-file", "", "New local destination (required; refuses overwrite)")
}

func projectFileMutationFlags(f *pflag.FlagSet) {
	f.String("operation-id", "", "New decision ID (default: generate a UUID); retry uses the saved ID")
	f.String("request-file", "", "New private JSON snapshot path (required; contains draft bytes, never credentials)")
}

func projectFileArgs(n int) cobra.PositionalArgs {
	validate := exactArgs(n)
	return func(cmd *cobra.Command, args []string) error {
		// Reuse the CLI's argument/help behavior while keeping stdout JSON-only.
		stdout := cmd.OutOrStdout()
		cmd.SetOut(cmd.ErrOrStderr())
		err := validate(cmd, args)
		cmd.SetOut(stdout)
		if err != nil {
			return printProjectFileResult(cmd, projectFileCommandResult{}, cli.NewProjectFileValidationError(fmt.Sprintf("expected %d arguments; see --help", n)))
		}
		return nil
	}
}

func printProjectFileResult(cmd *cobra.Command, result projectFileCommandResult, err error) error {
	if result.Value != nil {
		if printErr := cli.PrintJSON(cmd.OutOrStdout(), result.Value); printErr != nil {
			return printErr
		}
	} else if err != nil {
		state := "FAILED"
		if result.Unconfirmed {
			state = "UNCONFIRMED"
		}
		out := map[string]any{"state": state, "code": projectFileErrorCode(err), "error": cli.FormatError(err, false)}
		if result.OperationID != "" {
			out["operation_id"] = result.OperationID
		}
		if result.RequestFile != "" {
			out["request_file"] = result.RequestFile
		}
		if printErr := cli.PrintJSON(cmd.OutOrStdout(), out); printErr != nil {
			return printErr
		}
	}
	return err
}

func projectFileErrorCode(err error) string {
	var httpErr *cli.HTTPError
	if errors.As(err, &httpErr) {
		var envelope struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal([]byte(httpErr.Body), &envelope)
		if envelope.Code != "" {
			return envelope.Code
		}
		return "HTTP_" + strconv.Itoa(httpErr.StatusCode)
	}
	var feature *cli.ProjectFileError
	if errors.As(err, &feature) {
		return feature.Code
	}
	return "CLIENT_ERROR"
}

func projectFileOutcomeUnconfirmed(err error) bool {
	var httpErr *cli.HTTPError
	if errors.As(err, &httpErr) {
		if httpErr.StatusCode == 503 && projectFileErrorCode(err) == "PROJECT_FILES_DISABLED" {
			return false
		}
		return httpErr.StatusCode >= 500
	}
	exit := cli.ExitCodeFor(err)
	return exit == cli.ExitNetwork || exit == cli.ExitFileUnconfirmed
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

func executeProjectFile(cmd *cobra.Command, args []string, handler projectFileHandler) (projectFileCommandResult, error) {
	var result projectFileCommandResult
	output, _ := cmd.Flags().GetString("output")
	if output != "json" {
		return result, cli.NewProjectFileValidationError("project file commands support --output json only")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return result, err
	}
	if client.Token == "" || client.WorkspaceID == "" {
		return result, cli.NewProjectFileValidationError("shared files require an explicit workspace and authenticated credential")
	}
	serverURL, err := url.Parse(client.BaseURL)
	if err != nil || serverURL.User != nil || serverURL.RawQuery != "" || serverURL.Fragment != "" || serverURL.Host == "" || (serverURL.Scheme != "http" && serverURL.Scheme != "https") {
		return result, cli.NewProjectFileValidationError("invalid API server URL")
	}
	base := ""
	if cmd.Name() != "retry" {
		base, err = cli.ProjectFilesPath(args[0])
		if err != nil {
			return result, err
		}
	}
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	return handler(ctx, cmd, client, base, args)
}

func queryProjectFileCapabilities(ctx context.Context, _ *cobra.Command, client *cli.APIClient, base string, _ []string) (projectFileCommandResult, error) {
	raw, err := client.ProjectFileJSON(ctx, base+"/capabilities", "capabilities", "")
	return projectFileCommandResult{Value: projectFileRaw(raw)}, err
}

func listProjectFiles(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, _ []string) (projectFileCommandResult, error) {
	return listProjectFileCommand(ctx, cmd, client, base, "")
}

func listProjectFileCandidates(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, args []string) (projectFileCommandResult, error) {
	if err := cli.ValidateProjectFilePath(args[1]); err != nil {
		return projectFileCommandResult{}, err
	}
	return listProjectFileCommand(ctx, cmd, client, base, args[1])
}

func listProjectFileCommand(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, candidatePath string) (projectFileCommandResult, error) {
	limit, _ := cmd.Flags().GetInt("limit")
	if limit < 1 || limit > 200 {
		return projectFileCommandResult{}, cli.NewProjectFileValidationError("limit must be between 1 and 200")
	}
	query := make(url.Values)
	query.Set("limit", strconv.Itoa(limit))
	after, _ := cmd.Flags().GetString("after")
	if after != "" {
		query.Set("after", after)
	}
	kind := "list"
	if candidatePath != "" {
		kind = "candidates"
		query.Set("path", candidatePath)
		base += "/candidates"
	} else {
		prefix, _ := cmd.Flags().GetString("prefix")
		if prefix != "" {
			query.Set("prefix", prefix)
		}
	}
	raw, err := client.ProjectFileJSON(ctx, base+"?"+query.Encode(), kind, "")
	return projectFileCommandResult{Value: projectFileRaw(raw)}, err
}

func queryProjectFileOperation(ctx context.Context, _ *cobra.Command, client *cli.APIClient, base string, args []string) (projectFileCommandResult, error) {
	if err := cli.ValidateProjectFileOperationID(args[1]); err != nil {
		return projectFileCommandResult{}, err
	}
	raw, err := client.ProjectFileJSON(ctx, base+"/operations/"+url.PathEscape(args[1]), "operation", args[1])
	return projectFileCommandResult{Value: projectFileRaw(raw), OperationID: args[1], Unconfirmed: projectFileOutcomeUnconfirmed(err)}, err
}

func readProjectFile(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, args []string) (projectFileCommandResult, error) {
	return readProjectFileCommand(ctx, cmd, client, base, "read", args[1])
}

func readProjectFileCandidate(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, args []string) (projectFileCommandResult, error) {
	return readProjectFileCommand(ctx, cmd, client, base, "candidate", args[1])
}

func saveProjectFile(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, args []string) (projectFileCommandResult, error) {
	return mutateProjectFileCommand(ctx, cmd, client, base, args, "save")
}

func adoptProjectFileCandidate(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, args []string) (projectFileCommandResult, error) {
	return mutateProjectFileCommand(ctx, cmd, client, base, args, "adopt")
}

func mutateProjectFileCommand(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base string, args []string, kind string) (projectFileCommandResult, error) {
	r := cli.ProjectFileRequest{Kind: kind, ProjectID: strings.TrimSuffix(strings.TrimPrefix(base, "/api/projects/"), "/files"), Path: args[1]}
	r.OperationID, _ = cmd.Flags().GetString("operation-id")
	if r.OperationID == "" {
		r.OperationID = uuid.NewString()
	}
	result := projectFileCommandResult{OperationID: r.OperationID}
	requestFile, _ := cmd.Flags().GetString("request-file")
	if requestFile == "" {
		return result, cli.NewProjectFileValidationError("--request-file is required; use a new path for each new decision")
	}
	revisionFlag := "base-revision"
	if kind == "adopt" {
		revisionFlag = "expected-revision"
		id, err := uuid.Parse(args[2])
		if err != nil {
			return result, cli.NewProjectFileValidationError("candidate-id must be a UUID")
		}
		r.CandidateID = id.String()
	}
	if !cmd.Flags().Changed(revisionFlag) {
		return result, cli.NewProjectFileValidationError("--" + revisionFlag + " is required; never infer it from the latest head")
	}
	r.BaseRevision, _ = cmd.Flags().GetInt64(revisionFlag)
	if kind == "save" {
		r.ContentType, _ = cmd.Flags().GetString("content-type")
		source, _ := cmd.Flags().GetString("from-file")
		if source == "" {
			return result, cli.NewProjectFileValidationError("--from-file is required")
		}
		var err error
		r.Data, err = readProjectFileBounded(source, cli.ProjectFileMaxBytes)
		if err != nil {
			return result, err
		}
		r.SHA256 = fmt.Sprintf("%x", sha256.Sum256(r.Data))
	}
	if err := r.Validate(); err != nil {
		return result, err
	}
	snapshot := projectFileSnapshot{Version: 1, ServerURL: client.BaseURL, WorkspaceID: client.WorkspaceID, CredentialSHA256: projectFileCredentialBinding(client), Request: r}
	snapshot.RequestSHA256 = projectFileRequestDigest(r)
	data, err := json.Marshal(snapshot)
	if err != nil {
		return result, err
	}
	if err := writeProjectFileExclusive(requestFile, data); err != nil {
		return result, fmt.Errorf("snapshot not saved; no API mutation sent: %w", err)
	}
	result.RequestFile = requestFile
	fmt.Fprintf(cmd.ErrOrStderr(), "Request %s preserved in %s. Keep this file for operation lookup/retry.\n", r.OperationID, requestFile)
	if kind == "save" {
		if err := preflightProjectFileSave(ctx, client, base, int64(len(r.Data))); err != nil {
			return result, cli.WithUserMessage(cli.FormatError(err, false)+fmt.Sprintf(" Save preflight failed; no mutation sent. Request %s remains in %s.", r.OperationID, requestFile), err)
		}
	}
	return sendProjectFileMutation(ctx, client, r, result)
}

func preflightProjectFileSave(ctx context.Context, client *cli.APIClient, base string, size int64) error {
	raw, err := client.ProjectFileJSON(ctx, base+"/capabilities", "capabilities", "")
	if err != nil {
		return err
	}
	// ProjectFileJSON has validated the capability envelope and positive limit.
	var caps struct {
		MaxBytes int64 `json:"max_file_bytes"`
	}
	if err := json.Unmarshal(raw, &caps); err != nil {
		return err
	}
	if size > caps.MaxBytes {
		return &cli.ProjectFileError{Code: "FILE_TOO_LARGE", Message: fmt.Sprintf("draft is %d bytes; the server advertises a %d-byte file limit", size, caps.MaxBytes), Exit: cli.ExitValidation}
	}
	return nil
}

func retryProjectFile(ctx context.Context, _ *cobra.Command, client *cli.APIClient, _ string, args []string) (projectFileCommandResult, error) {
	result := projectFileCommandResult{RequestFile: args[0]}
	snapshot, err := readProjectFileSnapshot(args[0])
	if err != nil {
		return result, err
	}
	result.OperationID = snapshot.Request.OperationID
	if snapshot.ServerURL != client.BaseURL || snapshot.WorkspaceID != client.WorkspaceID || snapshot.CredentialSHA256 != projectFileCredentialBinding(client) {
		return result, cli.NewProjectFileValidationError("request belongs to a different server, workspace or credential; do not replay it as another run/member")
	}
	// Recovery must reach the original operation even if capabilities changed.
	return sendProjectFileMutation(ctx, client, snapshot.Request, result)
}

func sendProjectFileMutation(ctx context.Context, client *cli.APIClient, request cli.ProjectFileRequest, result projectFileCommandResult) (projectFileCommandResult, error) {
	raw, err := client.MutateProjectFile(ctx, request)
	result.Value = projectFileRaw(raw)
	result.Unconfirmed = projectFileOutcomeUnconfirmed(err)
	return result, projectFileMutationError(err, result.RequestFile, result.OperationID)
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
	if errors.As(err, &httpErr) && projectFileOutcomeUnconfirmed(err) {
		err = &cli.ProjectFileError{Code: "OUTCOME_UNCONFIRMED", Message: message, Exit: cli.ExitFileUnconfirmed, Err: err}
	}
	if !projectFileOutcomeUnconfirmed(err) {
		return cli.WithUserMessage(message+fmt.Sprintf(" This attempt failed; request %s remains in %s. A rejected retry does not resolve an earlier uncertain attempt. After 401/403, stop; never switch to another actor's credential.", id, snapshot), err)
	}
	return cli.WithUserMessage(message+fmt.Sprintf(" Request %s remains in %s; no save confirmation. Query this operation before retrying the snapshot unchanged. After 401/403, stop; never switch to another actor's credential. For 202/503 wait at least one second.", id, snapshot), err)
}

func readProjectFileBounded(path string, limit int64) ([]byte, error) {
	// Reject pipes/devices before opening: opening a FIFO can itself block.
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if err := validateProjectFileInput(info, limit); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// Recheck the opened descriptor: the path may have changed since Stat.
	info, err = f.Stat()
	if err != nil {
		return nil, err
	}
	if err := validateProjectFileInput(info, limit); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, cli.NewProjectFileValidationError("input exceeds the CLI size limit")
	}
	return data, nil
}

func validateProjectFileInput(info os.FileInfo, limit int64) error {
	if !info.Mode().IsRegular() || info.Size() > limit {
		return cli.NewProjectFileValidationError("input must be a regular file within the CLI size limit")
	}
	return nil
}

func readProjectFileSnapshot(path string) (projectFileSnapshot, error) {
	var snapshot projectFileSnapshot
	// Save bytes expand to padded base64 in JSON; reserve 1 MiB for metadata.
	limit := int64(base64.StdEncoding.EncodedLen(int(cli.ProjectFileMaxBytes))) + (1 << 20)
	data, err := readProjectFileBounded(path, limit)
	if err != nil {
		return snapshot, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return snapshot, cli.NewProjectFileValidationError("invalid request snapshot: " + err.Error())
	}
	if decoder.Decode(new(any)) != io.EOF || snapshot.Version != 1 {
		return snapshot, cli.NewProjectFileValidationError("invalid request snapshot version or trailing data")
	}
	if snapshot.RequestSHA256 != projectFileRequestDigest(snapshot.Request) {
		return snapshot, cli.NewProjectFileValidationError("request snapshot was edited; retry must retain the original operation, revision, target and bytes")
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

func readProjectFileCommand(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, base, action, argument string) (projectFileCommandResult, error) {
	var result projectFileCommandResult
	destination, _ := cmd.Flags().GetString("to-file")
	if destination == "" {
		return result, cli.NewProjectFileValidationError("--to-file is required; use a new local path")
	}
	if _, err := os.Lstat(destination); err == nil {
		return result, cli.NewProjectFileValidationError("destination already exists; choose a new path to preserve your working copy")
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	query, candidateID := make(url.Values), ""
	var revision *int64
	if action == "read" {
		if err := cli.ValidateProjectFilePath(argument); err != nil {
			return result, err
		}
		query.Set("path", argument)
		if cmd.Flags().Changed("revision") {
			n, _ := cmd.Flags().GetInt64("revision")
			if n < 1 || n > cli.ProjectFileMaxRevision+1 {
				return result, cli.NewProjectFileValidationError("revision must be a positive supported revision")
			}
			revision = &n
			query.Set("revision", strconv.FormatInt(n, 10))
		}
		base += "/content?" + query.Encode()
	} else {
		id, err := uuid.Parse(argument)
		if err != nil {
			return result, cli.NewProjectFileValidationError("candidate-id must be a UUID")
		}
		candidateID = id.String()
		base += "/candidates/" + candidateID + "/content"
	}
	meta, data, err := client.DownloadProjectFile(ctx, base, candidateID, revision)
	if err != nil {
		return result, err
	}
	if err := writeProjectFileExclusive(destination, data); err != nil {
		return result, err
	}
	result.Value = struct {
		cli.ProjectFileDownload
		LocalFile string `json:"local_file"`
	}{meta, destination}
	return result, nil
}
