package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

func newIssueDependencyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "dependency",
		Short: "Read and edit an issue's prerequisites",
		Long: "Read direct and inherited prerequisites, unfinished prerequisites, and direct successors.\n" +
			"Add/remove edit only direct prerequisites using the server's current version.\n" +
			"A conflict fails without retrying; read again before deciding how to proceed.\n" +
			"The server controls permission to remove unfinished prerequisites.",
	}
	for _, action := range []string{"list", "add", "remove"} {
		sub := &cobra.Command{Use: action + " <issue>", Args: exactArgs(1), RunE: runIssueDependency}
		sub.Flags().String("output", "json", "Output format: table or json")
		if action == "list" {
			sub.Short = "List direct/inherited prerequisites and direct successors"
		} else {
			sub.Short = action + " direct prerequisites with a version check"
			sub.Flags().StringArray("blocked-by", nil, "Prerequisite issue key or full UUID (repeatable, one per flag)")
			sub.Example = "  multica issue dependency " + action + " MUL-42 --blocked-by MUL-39 --blocked-by MUL-41"
		}
		cmd.AddCommand(sub)
	}
	return cmd
}

func registerIssueDependencyFlags(cmd *cobra.Command, updating bool) {
	cmd.Flags().StringArray("blocked-by", nil, "Direct prerequisite issue key or full UUID (repeatable); on update, replaces ALL direct prerequisites")
	if updating {
		cmd.Flags().Bool("clear-blocked-by", false, "Clear ALL direct prerequisites (server permissions apply); mutually exclusive with --blocked-by")
		cmd.MarkFlagsMutuallyExclusive("blocked-by", "clear-blocked-by")
	}
}

func issueDependencyFlagValues(cmd *cobra.Command) ([]string, bool, error) {
	set, clear := cmd.Flags().Changed("blocked-by"), cmd.Flags().Changed("clear-blocked-by")
	if set && clear {
		return nil, false, fmt.Errorf("--blocked-by and --clear-blocked-by are mutually exclusive")
	}
	if clear {
		value, _ := cmd.Flags().GetBool("clear-blocked-by")
		if !value {
			return nil, false, fmt.Errorf("--clear-blocked-by must be true when supplied")
		}
		return []string{}, true, nil
	}
	refs, _ := cmd.Flags().GetStringArray("blocked-by")
	if set && len(refs) == 0 {
		return nil, false, fmt.Errorf("--blocked-by requires an issue key or full UUID; use --clear-blocked-by to clear prerequisites")
	}
	for _, ref := range refs {
		if strings.TrimSpace(ref) == "" {
			return nil, false, fmt.Errorf("--blocked-by requires an issue key or full UUID; use --clear-blocked-by to clear prerequisites")
		}
	}
	return refs, set, nil
}

func resolvePrerequisites(ctx context.Context, client *cli.APIClient, refs []string) ([]string, error) {
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		resolved, err := resolveIssueRef(ctx, client, ref)
		if err != nil {
			return nil, fmt.Errorf("resolve prerequisite: %w", err)
		}
		if !uuidRegexp.MatchString(resolved.ID) {
			return nil, fmt.Errorf("prerequisite lookup returned an invalid issue ID")
		}
		ids = appendUniqueStrings(ids, resolved.ID)
	}
	return ids, nil
}

// Keep the original response for JSON output, including future additive fields.
// This small projection validates only what the CLI needs to edit or display.
type issuePrerequisite struct {
	IssueID       string   `json:"issue_id"`
	Identifier    string   `json:"identifier"`
	Title         string   `json:"title"`
	Status        string   `json:"status"`
	Satisfied     *bool    `json:"satisfied"`
	InheritedFrom []string `json:"inherited_from"`
}

type issueDependencyView struct {
	BlockedBy             []issuePrerequisite `json:"blocked_by"`
	InheritedBlockedBy    []issuePrerequisite `json:"inherited_blocked_by"`
	Blocking              []issuePrerequisite `json:"blocking"`
	Unsatisfied           []issuePrerequisite `json:"unsatisfied"`
	HasRestrictedBlockers *bool               `json:"has_restricted_blockers"`
	DependencyVersion     string              `json:"dependency_version"`
}

func parseIssueDependencies(raw any) (issueDependencyView, error) {
	var view issueDependencyView
	data, err := json.Marshal(raw)
	if err == nil {
		err = json.Unmarshal(data, &view)
	}
	valid := err == nil && view.DependencyVersion != "" && view.HasRestrictedBlockers != nil
	for _, entries := range [][]issuePrerequisite{view.BlockedBy, view.InheritedBlockedBy, view.Blocking, view.Unsatisfied} {
		valid = valid && entries != nil
		for _, entry := range entries {
			valid = valid && uuidRegexp.MatchString(entry.IssueID) && entry.Satisfied != nil && entry.Status != ""
		}
	}
	if !valid {
		return view, fmt.Errorf("dependency response is missing or malformed; readiness is unknown, no prerequisite edit was sent")
	}
	return view, nil
}

func fetchIssueDependencies(ctx context.Context, client *cli.APIClient, id string) (map[string]any, issueDependencyView, error) {
	var raw map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+id+"/dependencies", &raw); err != nil {
		return nil, issueDependencyView{}, err
	}
	view, err := parseIssueDependencies(raw)
	return raw, view, err
}

func prepareIssueDependencyWrite(ctx context.Context, client *cli.APIClient, cmd *cobra.Command, body map[string]any, issueID string) (bool, error) {
	refs, changed, err := issueDependencyFlagValues(cmd)
	if err != nil || !changed {
		return changed, err
	}
	ids, err := resolvePrerequisites(ctx, client, refs)
	if err != nil {
		return true, err
	}
	if issueID != "" {
		_, view, err := fetchIssueDependencies(ctx, client, issueID)
		if err != nil {
			return true, err
		}
		body["expected_dependency_version"] = view.DependencyVersion
	}
	body["blocked_by"] = ids
	return true, nil
}

func runIssueDependency(cmd *cobra.Command, args []string) error {
	action := cmd.Name()
	refs, changed, err := issueDependencyFlagValues(cmd)
	if err != nil {
		return err
	}
	if action != "list" && !changed {
		return fmt.Errorf("--blocked-by is required (repeat for multiple prerequisites)")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	issue, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return err
	}
	ids, err := resolvePrerequisites(ctx, client, refs)
	if err != nil {
		return err
	}
	raw, view, err := fetchIssueDependencies(ctx, client, issue.ID)
	if err != nil {
		return err
	}
	if action == "list" {
		output, _ := cmd.Flags().GetString("output")
		if output == "table" {
			printIssueDependencies(view)
			return nil
		}
		return cli.PrintJSON(os.Stdout, raw)
	}
	if action == "remove" {
		for _, entry := range view.InheritedBlockedBy {
			if slices.Contains(ids, entry.IssueID) {
				return fmt.Errorf("prerequisite %s is inherited; edit its source issue(s) %s", entry.IssueID, strings.Join(entry.InheritedFrom, ", "))
			}
		}
	}
	blockedBy := make([]string, 0, len(view.BlockedBy)+len(ids))
	for _, entry := range view.BlockedBy {
		if action != "remove" || !slices.Contains(ids, entry.IssueID) {
			blockedBy = append(blockedBy, entry.IssueID)
		}
	}
	if action == "add" {
		blockedBy = appendUniqueStrings(blockedBy, ids...)
	}
	var result map[string]any
	body := map[string]any{"blocked_by": blockedBy, "expected_dependency_version": view.DependencyVersion}
	if err := client.PatchJSON(ctx, "/api/issues/"+issue.ID+"/with-dependencies", body, &result); err != nil {
		return err
	}
	return printIssueMutation(cmd, result)
}

func printIssueDependencies(view issueDependencyView) {
	rows := [][]string{}
	for _, group := range []struct {
		name    string
		entries []issuePrerequisite
	}{{"direct", view.BlockedBy}, {"inherited", view.InheritedBlockedBy}, {"blocking", view.Blocking}} {
		for _, entry := range group.entries {
			key := entry.Identifier
			if key == "" {
				key = entry.IssueID
			}
			rows = append(rows, []string{group.name, key, entry.Title, entry.Status, fmt.Sprint(*entry.Satisfied), strings.Join(entry.InheritedFrom, ", ")})
		}
	}
	cli.PrintTable(os.Stdout, []string{"RELATION", "ISSUE", "TITLE", "STATUS", "SATISFIED", "INHERITED FROM"}, rows)
	fmt.Fprintf(os.Stdout, "Unfinished prerequisites: %d; restricted blockers: %t\nDependency version: %s\n", len(view.Unsatisfied), *view.HasRestrictedBlockers, view.DependencyVersion)
}

func printIssueMutation(cmd *cobra.Command, result map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output != "table" {
		return cli.PrintJSON(os.Stdout, result)
	}
	cli.PrintTable(os.Stdout, []string{"KEY", "TITLE", "STATUS", "PRIORITY"}, [][]string{{
		issueDisplayKey(result), strVal(result, "title"), strVal(result, "status"), strVal(result, "priority"),
	}})
	if raw, ok := result["dependencies"]; ok {
		view, err := parseIssueDependencies(raw)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Issue saved; dependency diagnostics unavailable. Read dependencies again; do not repeat the write.")
		} else {
			printIssueDependencies(view)
		}
	}
	if dispatch, ok := result["dispatch"].(map[string]any); ok {
		fmt.Fprintf(os.Stdout, "Dispatch: %s (%s)\n", strVal(dispatch, "status"), strVal(dispatch, "reason_code"))
	}
	return nil
}

// Called once at the process boundary so legacy assign/status/rerun paths also
// preserve dependency refusals. JSON goes to stdout; guidance goes to stderr.
func issueDependencyCommandError(cmd *cobra.Command, err error) error {
	var httpErr *cli.HTTPError
	if cmd == nil || !errors.As(err, &httpErr) {
		return err
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(httpErr.Body), &payload)
	code := strVal(payload, "reason_code")
	dependencyPath := strings.HasPrefix(httpErr.Path, "/api/issues/") &&
		(strings.HasSuffix(httpErr.Path, "/dependencies") || strings.HasSuffix(httpErr.Path, "/with-dependencies"))
	if !strings.HasPrefix(code, "dependency_") && !dependencyPath {
		return err
	}
	message := cli.FormatError(err, false)
	if code != "" {
		message = fmt.Sprintf("%s (%s)", strVal(payload, "error"), code)
	}
	if dependencyPath && (httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusMethodNotAllowed) {
		message += " Dependency API unavailable, disabled, or issue inaccessible. Check server support and access; no fallback write was sent."
	}
	if code == "dependency_unsatisfied" || code == "dependency_change_not_allowed" || code == "dependency_override_not_allowed" {
		message += " Stop this dispatch/edit; suggest next steps or request human handling. Keep using your own credentials."
	}
	if code == "dependency_version_conflict" {
		message += " Read dependencies again before deciding on a new edit; no automatic retry was sent."
	}
	if view, ok := payload["dependencies"].(map[string]any); ok {
		if entries, ok := view["unsatisfied"].([]any); ok {
			for _, raw := range entries {
				if entry, ok := raw.(map[string]any); ok {
					message += fmt.Sprintf("\nUnfinished: %s %s (%s)", strVal(entry, "issue_id"), strVal(entry, "title"), strVal(entry, "status"))
				}
			}
		}
		if restricted, _ := view["has_restricted_blockers"].(bool); restricted {
			message += "\nAdditional unfinished prerequisites are restricted."
		}
	}
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		var data any = json.RawMessage(httpErr.Body)
		if payload == nil {
			data = map[string]any{"error": message, "http_status": httpErr.StatusCode}
		}
		if printErr := cli.PrintJSON(os.Stdout, data); printErr != nil {
			message += fmt.Sprintf("\nCould not print error JSON: %v", printErr)
		}
	}
	return cli.WithUserMessage(message, err)
}

func commentDispatchError(result map[string]any) error {
	outcomes, _ := result["trigger_outcomes"].([]any)
	var blocked []string
	for _, raw := range outcomes {
		outcome, ok := raw.(map[string]any)
		if ok && strVal(outcome, "status") == "blocked" {
			blocked = append(blocked, fmt.Sprintf("%s:%s (%s)", strVal(outcome, "target_type"), strVal(outcome, "target_id"), strVal(outcome, "reason_code")))
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	return fmt.Errorf("comment %s saved; %d target(s) not started: %s. Do not repost the comment. For unmet prerequisites, suggest next steps or request human handling", strVal(result, "id"), len(blocked), strings.Join(blocked, ", "))
}
