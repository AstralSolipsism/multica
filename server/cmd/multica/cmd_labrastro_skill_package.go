package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

func init() {
	skillCmd.AddCommand(newSkillPackageCmd())
}

func newSkillPackageCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "package", Short: "Import and inspect workspace skill packages"}
	for _, action := range []string{"import", "list", "get", "rescan"} {
		sub := &cobra.Command{RunE: runSkillPackage, Args: exactArgs(1)}
		output := "json"
		switch action {
		case "import":
			sub.Use = "import <url>"
			sub.Short = "Preview and import a GitHub or skills.sh repository"
			sub.Long = "Import through the workspace API using the server's manifest defaults.\n" +
				"Use --dry-run for a read-only preview. " + skillPackageTimeoutHelp
			sub.Flags().Bool("dry-run", false, "Only preview; do not create or update workspace data")
		case "rescan":
			sub.Use = "rescan <package-id>"
			sub.Short = "Preview changes from a package's saved URL and ref"
			sub.Long = "Preview only unless --apply is supplied. Apply defaults to changed imported skills;\n" +
				"new skills require --skill or --all. Removed source paths are retained.\n" +
				skillPackageTimeoutHelp + "\nFailed writes are never retried automatically."
			sub.Flags().Bool("apply", false, "Apply after a fresh preview")
		case "list":
			sub.Use, sub.Short, sub.Args = "list", "List packages in the workspace", exactArgs(0)
			output = "table"
		case "get":
			sub.Use, sub.Short = "get <package-id>", "Get package metadata and its last applied candidate summary"
		}
		if action == "import" || action == "rescan" {
			sub.Flags().StringArray("skill", nil, "Repository-relative skill directory (repeatable; use an empty string for the repository root)")
			sub.Flags().Bool("all", false, "Select all candidates, including candidates with failures")
			sub.Flags().String("on-conflict", "skip", "Conflict strategy: skip, rename, or overwrite")
			sub.MarkFlagsMutuallyExclusive("skill", "all")
		}
		sub.Flags().String("output", output, "Output format: table or json")
		cmd.AddCommand(sub)
	}
	return cmd
}

func runSkillPackage(cmd *cobra.Command, args []string) error {
	output, _ := cmd.Flags().GetString("output")
	if output != "json" && output != "table" {
		return fmt.Errorf("--output must be table or json")
	}
	action := cmd.Name()
	body := map[string]any{}
	if action == "import" || action == "rescan" {
		if cmd.Flags().Changed("skill") && cmd.Flags().Changed("all") {
			return fmt.Errorf("--skill and --all are mutually exclusive")
		}
		strategy, _ := cmd.Flags().GetString("on-conflict")
		if !slices.Contains([]string{"skip", "rename", "overwrite"}, strategy) {
			return fmt.Errorf("--on-conflict must be skip, rename, or overwrite")
		}
		body["on_conflict"] = strategy
		if cmd.Flags().Changed("skill") {
			body["skills"], _ = cmd.Flags().GetStringArray("skill")
		}
		if all, _ := cmd.Flags().GetBool("all"); all {
			body["all"] = true
		}
	}
	path := "/api/skill-packages"
	if action == "get" || action == "rescan" {
		if !uuidRegexp.MatchString(args[0]) {
			return fmt.Errorf("package-id must be a full UUID")
		}
		path += "/" + args[0]
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if action == "list" || action == "get" {
		result, err := requestSkillPackage(cmd, client, path, nil)
		if err != nil {
			return err
		}
		return printSkillPackageResponse(cmd, result, action)
	}
	previewBody := map[string]any{}
	previewPath := path + "/preview"
	applyPath := path + "/apply"
	apply, _ := cmd.Flags().GetBool("apply")
	if action == "import" {
		previewBody["url"] = args[0]
		dryRun, _ := cmd.Flags().GetBool("dry-run")
		apply = !dryRun
	} else {
		previewPath, applyPath = path+"/rescan", path+"/rescan"
		body["apply"] = true
	}
	preview, err := requestSkillPackage(cmd, client, previewPath, previewBody)
	if err != nil {
		return err
	}
	if err := validateSkillPackageResponse(preview, "preview"); err != nil {
		return printSkillPackageResponse(cmd, preview, "preview")
	}
	if err := validateSkillPackageSelection(preview, body); err != nil {
		if printErr := printSkillPackageResponse(cmd, preview, "preview"); printErr != nil {
			return printErr
		}
		return err
	}
	warnSkillPackageDuplicateNames(cmd.ErrOrStderr(), preview, body)
	if !apply {
		next := "Omit --dry-run to apply."
		if action == "rescan" {
			next = "Use --apply to update this package."
		}
		fmt.Fprintln(cmd.ErrOrStderr(), "Read-only preview; no workspace changes. "+next)
		if cmd.Flags().Changed("skill") || cmd.Flags().Changed("all") || cmd.Flags().Changed("on-conflict") {
			fmt.Fprintln(cmd.ErrOrStderr(), "Selection/conflict flags were not applied to this preview; stdout shows the server's default selection.")
		}
		return printSkillPackageResponse(cmd, preview, "preview")
	}
	// Do not resolve manifests or filter on can_write here: rename may create
	// an independent skill even when the existing target cannot be overwritten.
	// Omitting both selectors delegates defaults (including rescan) to the server.
	body["preview_id"] = preview["preview_id"]
	if action == "import" {
		body["url"] = nestedMap(preview, "source")["url"]
	}
	result, err := requestSkillPackage(cmd, client, applyPath, body)
	if err != nil {
		return err
	}
	if err := printSkillPackageResponse(cmd, result, "apply"); err != nil {
		return err
	}
	// The contract reports every preview candidate, including unselected and
	// removed paths. An empty or truncated report cannot establish success.
	paths := map[string]bool{}
	for _, item := range result["results"].([]any) {
		paths[strVal(item.(map[string]any), "path")] = true
	}
	candidates := preview["candidates"].([]any)
	complete := len(paths) == len(candidates)
	for _, item := range candidates {
		complete = complete && paths[strVal(item.(map[string]any), "path")]
	}
	if !complete {
		return fmt.Errorf("skill package report does not cover every preview candidate; result is indeterminate. %s", skillPackageRepreview)
	}
	return nil
}

const skillPackageTimeoutHelp = "The server has a 45-second work limit; the CLI waits at least 60 seconds for its report and honors MULTICA_HTTP_TIMEOUT."

const skillPackageRepreview = "Preview again with 'multica skill package import <url> --dry-run' or 'multica skill package rescan <package-id>', inspect the report, then explicitly select any remaining items."

func requestSkillPackage(cmd *cobra.Command, client *cli.APIClient, path string, body map[string]any) (map[string]any, error) {
	// Both transport and context must outlive the server's 45s work deadline
	// so it can return partial results. Each request gets a fresh finite budget.
	timeout := cli.AtLeastAPITimeout(60 * time.Second)
	client.HTTPClient.Timeout = timeout
	ctx, cancel := context.WithTimeout(cmd.Context(), timeout)
	defer cancel()
	var result map[string]any
	var err error
	if body == nil {
		err = client.GetJSON(ctx, path, &result)
	} else {
		err = client.PostJSON(ctx, path, body, &result)
	}
	if err == nil {
		return result, nil
	}
	var httpErr *cli.HTTPError
	isHTTPError := errors.As(err, &httpErr)
	if isHTTPError && !httpErr.BodyTruncated && json.Unmarshal([]byte(httpErr.Body), &result) == nil && result != nil {
		// Preserve structured server errors too, without a second JSON document.
		if printErr := cli.PrintJSON(cmd.OutOrStdout(), result); printErr != nil {
			return nil, printErr
		}
	}
	writing := body != nil && (strings.HasSuffix(path, "/apply") || body["apply"] == true)
	if writing && isHTTPError && httpErr.StatusCode == http.StatusConflict {
		return nil, cli.WithUserMessage("Skill package apply conflict. "+skillPackageRepreview, err)
	}
	if writing && (!isHTTPError || httpErr.StatusCode >= 500) {
		return nil, cli.WithUserMessage(cli.FormatError(err, false)+" The apply result is indeterminate. "+skillPackageRepreview, err)
	}
	return nil, err
}

func validateSkillPackageSelection(preview, selection map[string]any) error {
	requested, ok := selection["skills"].([]string)
	if !ok {
		return nil
	}
	available := []string{}
	for _, item := range preview["candidates"].([]any) {
		available = append(available, strVal(item.(map[string]any), "path"))
	}
	unknown := []string{}
	for _, path := range requested {
		if !slices.Contains(available, path) {
			unknown = append(unknown, path)
		}
	}
	if len(unknown) > 0 {
		return fmt.Errorf("--skill paths are not in the preview: %q; available paths: %q", unknown, available)
	}
	return nil
}

// Validate the fields needed by this Go CLI against the frozen wire contract
// (docs/engineering/labrastro-skill-packages.md). Keep the original map for
// output, including additive fields; do not introduce another API model.
func validateSkillPackageResponse(result map[string]any, kind string) error {
	invalid := func(field string) error {
		recovery := "Check server/CLI compatibility and repeat the read."
		if kind == "preview" || kind == "apply" {
			recovery = skillPackageRepreview
		}
		return fmt.Errorf("skill package %s response has a missing, malformed, or unsupported %s; result is indeterminate. %s", kind, field, recovery)
	}
	if result == nil {
		return invalid("object")
	}
	if kind == "get" {
		if !validSkillPackageMetadata(result) {
			return invalid("package")
		}
		return nil
	}
	if kind == "list" {
		packages, ok := result["packages"].([]any)
		if !ok {
			return invalid("packages")
		}
		for _, p := range packages {
			m, _ := p.(map[string]any)
			if !validSkillPackageMetadata(m) {
				return invalid("package")
			}
		}
		return nil
	}
	if !validSkillPackageDiagnostics(result["diagnostics"]) {
		return invalid("diagnostics")
	}
	if p, exists := result["package"]; exists {
		m, _ := p.(map[string]any)
		if !validSkillPackageMetadata(m) {
			return invalid("package")
		}
	}
	key := "results"
	if kind == "preview" {
		key = "candidates"
		source := nestedMap(result, "source")
		if !skillPackageStrings(result, true, "preview_id") ||
			!skillPackageStrings(source, true, "url", "owner_repo", "ref", "revision") ||
			!skillPackageStrings(source, false, "subdirectory") {
			return invalid("preview_id/source")
		}
	} else if _, ok := result["failed"].(bool); !ok {
		return invalid("failed")
	}
	items, ok := result[key].([]any)
	if !ok {
		return invalid(key)
	}
	seen := map[string]bool{}
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok || !skillPackageStrings(m, false, "path") || !validSkillPackageDiagnostics(m["diagnostics"]) ||
			!skillPackageOptionalStrings(m, "skill_id", "code", "reason", "conflict", "description", "digest") {
			return invalid(key + " item")
		}
		path := m["path"].(string)
		if seen[path] {
			return invalid("duplicate path")
		}
		seen[path] = true
		if kind == "preview" {
			_, selectedOK := m["default_selected"].(bool)
			_, writableOK := m["can_write"].(bool)
			if !selectedOK || !writableOK || !skillPackageStrings(m, false, "name") ||
				!slices.Contains([]string{"new", "adoptable", "changed", "unchanged", "removed", "conflict", "failed"}, strVal(m, "state")) {
				// Fail closed on newer states before sending any apply request.
				return invalid("candidate state/selection")
			}
			shared, ok := m["shared_files"].([]any)
			if !ok {
				return invalid("shared_files")
			}
			for _, path := range shared {
				if _, ok := path.(string); !ok {
					return invalid("shared_files path")
				}
			}
			for _, field := range []string{"file_count", "bytes"} {
				if value, exists := m[field]; exists && !skillPackageNumber(value, 0) {
					return invalid(field)
				}
			}
		} else if !slices.Contains([]string{"created", "adopted", "updated", "unchanged", "skipped", "retained", "failed"}, strVal(m, "status")) {
			return invalid("item status")
		} else {
			if _, ok := m["retryable"].(bool); !ok {
				return invalid("retryable")
			}
			if slices.Contains([]string{"created", "adopted", "updated", "unchanged", "retained"}, strVal(m, "status")) &&
				(!skillPackageStrings(m, true, "skill_id") || result["package"] == nil) {
				return invalid("applied skill/package")
			}
		}
	}
	return nil
}

func skillPackageStrings(m map[string]any, nonempty bool, keys ...string) bool {
	for _, key := range keys {
		v, ok := m[key].(string)
		if !ok || nonempty && strings.TrimSpace(v) == "" {
			return false
		}
	}
	return true
}

func skillPackageOptionalStrings(m map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, exists := m[key]; exists && !skillPackageStrings(m, false, key) {
			return false
		}
	}
	return true
}

func skillPackageNumber(value any, min float64) bool {
	n, ok := value.(float64)
	return ok && n >= min && n == float64(int64(n))
}

func validSkillPackageMetadata(m map[string]any) bool {
	if !skillPackageStrings(m, true, "id", "workspace_id", "owner_repo", "source_url", "ref", "root_folder_id", "created_by") ||
		!skillPackageStrings(m, false, "subdirectory") {
		return false
	}
	if !skillPackageNumber(m["revision"], 1) {
		return false
	}
	candidates, ok := m["candidates"].([]any)
	if !ok {
		return false
	}
	for _, candidate := range candidates {
		c, _ := candidate.(map[string]any)
		if !skillPackageStrings(c, false, "path", "name") || !skillPackageOptionalStrings(c, "description", "digest") {
			return false
		}
	}
	return true
}

func validSkillPackageDiagnostics(value any) bool {
	diagnostics, ok := value.([]any)
	if !ok {
		return false
	}
	for _, value := range diagnostics {
		d, _ := value.(map[string]any)
		_, retryableOK := d["retryable"].(bool)
		if !skillPackageStrings(d, true, "code") || !skillPackageStrings(d, false, "message") ||
			!retryableOK || !skillPackageOptionalStrings(d, "path", "target") {
			return false
		}
	}
	return true
}

func printSkillPackageResponse(cmd *cobra.Command, result map[string]any, kind string) error {
	validationErr := validateSkillPackageResponse(result, kind)
	failed := false
	if kind == "apply" && validationErr == nil {
		failed, _ = result["failed"].(bool)
		for _, item := range result["results"].([]any) {
			failed = failed || item.(map[string]any)["status"] == "failed"
		}
	}
	output, _ := cmd.Flags().GetString("output")
	// Failure reports must remain complete and machine-readable even when the
	// caller normally prefers tables. Warnings and exit errors use stderr.
	if output == "json" || validationErr != nil || failed {
		if err := cli.PrintJSON(cmd.OutOrStdout(), result); err != nil {
			return err
		}
	} else {
		printSkillPackageTable(cmd, result, kind)
	}
	if validationErr != nil {
		return validationErr
	}
	if failed {
		return fmt.Errorf("one or more skill package items failed; successful items remain applied. %s", skillPackageRepreview)
	}
	return nil
}

func printSkillPackageTable(cmd *cobra.Command, result map[string]any, kind string) {
	w := cmd.OutOrStdout()
	if kind == "list" || kind == "get" {
		packages := []any{result}
		if kind == "list" {
			packages = result["packages"].([]any)
		}
		rows := make([][]string, 0, len(packages))
		for _, item := range packages {
			p := item.(map[string]any)
			rows = append(rows, []string{strVal(p, "id"), strVal(p, "owner_repo"), strVal(p, "subdirectory"), strVal(p, "ref"), strVal(p, "source_url")})
		}
		cli.PrintTable(w, []string{"ID", "REPOSITORY", "SUBDIRECTORY", "REF", "SOURCE"}, rows)
		if kind == "get" {
			rows = nil
			for _, item := range result["candidates"].([]any) {
				c := item.(map[string]any)
				rows = append(rows, []string{skillPackageDisplayPath(c), strVal(c, "name"), strVal(c, "description"), strVal(c, "digest")})
			}
			cli.PrintTable(w, []string{"PATH (LAST APPLIED)", "NAME", "DESCRIPTION", "DIGEST"}, rows)
		}
		return
	}
	key := "results"
	headers := []string{"PATH", "STATUS", "SKILL_ID", "CODE", "REASON", "RETRYABLE"}
	if kind == "preview" {
		key = "candidates"
		headers = []string{"PATH", "NAME", "STATE", "DEFAULT", "CAN_WRITE", "CONFLICT", "FILES", "SIZE"}
		source := nestedMap(result, "source")
		fmt.Fprintf(w, "Source: %s (ref %s, revision %s)\n", strVal(source, "url"), strVal(source, "ref"), strVal(source, "revision"))
		fmt.Fprintln(w, "Read-only preview. DEFAULT shows the server selection without --skill/--all.")
	}
	if p := nestedMap(result, "package"); len(p) > 0 {
		fmt.Fprintf(w, "Package: %s (saved source %s, ref %s)\n", strVal(p, "id"), strVal(p, "source_url"), strVal(p, "ref"))
	}
	rows := [][]string{}
	for _, item := range result[key].([]any) {
		m := item.(map[string]any)
		row := []string{skillPackageDisplayPath(m)}
		fields := []string{"status", "skill_id", "code", "reason", "retryable"}
		if kind == "preview" {
			fields = []string{"name", "state", "default_selected", "can_write", "conflict", "file_count", "bytes"}
		}
		for _, field := range fields {
			if size, ok := m[field].(float64); field == "bytes" && ok {
				row = append(row, formatBytes(int64(size)))
			} else {
				row = append(row, strVal(m, field))
			}
		}
		rows = append(rows, row)
	}
	cli.PrintTable(w, headers, rows)
	printSkillDiagnostics(w, result)
	for _, item := range result[key].([]any) {
		m := item.(map[string]any)
		if len(m["diagnostics"].([]any)) > 0 {
			fmt.Fprintf(w, "Diagnostics for %s:\n", skillPackageDisplayPath(m))
			printSkillDiagnostics(w, m)
		}
	}
}

func skillPackageDisplayPath(m map[string]any) string {
	if p := strVal(m, "path"); p != "" {
		return p
	}
	return "(repository root)"
}

func warnSkillPackageDuplicateNames(w io.Writer, preview, selection map[string]any) {
	paths := map[string][]string{}
	for _, item := range preview["candidates"].([]any) {
		c := item.(map[string]any)
		// Only new candidates selected for the next apply can race each other
		// for a name. Imported/renamed candidates do not have this limitation.
		selected := c["default_selected"] == true
		if explicit, ok := selection["skills"].([]string); ok {
			selected = slices.Contains(explicit, strVal(c, "path"))
		} else if selection["all"] == true {
			selected = true
		}
		if selected && strVal(c, "state") == "new" && strVal(c, "name") != "" {
			name := strVal(c, "name")
			paths[name] = append(paths[name], skillPackageDisplayPath(c))
		}
	}
	names := []string{}
	for name, candidates := range paths {
		if len(candidates) > 1 {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	for _, name := range names {
		fmt.Fprintf(w, "Warning: candidates named %q (%s) may return name_conflict on the first apply, even with --on-conflict rename. %s\n", name, strings.Join(paths[name], ", "), skillPackageRepreview)
	}
}

// Single-skill import and refresh also expose these optional diagnostics.
func printSkillDiagnostics(w io.Writer, result map[string]any) {
	diagnostics, _ := result["diagnostics"].([]any)
	for _, item := range diagnostics {
		d, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fmt.Fprintf(w, "Diagnostic %s: %s", strVal(d, "code"), strVal(d, "message"))
		for _, key := range []string{"path", "target", "retryable"} {
			if _, exists := d[key]; exists {
				fmt.Fprintf(w, " (%s=%s)", key, strVal(d, key))
			}
		}
		fmt.Fprintln(w)
	}
}
