package main

import (
	"bufio"
	"fmt"
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func runSkillPackageRemoval(cmd *cobra.Command, client *cli.APIClient, path string) error {
	preview, err := requestSkillPackage(cmd, client, path+"/delete-preview", nil)
	if err != nil {
		return err
	}
	if err := validateSkillPackageRemovalPreview(preview); err != nil {
		return err
	}
	dryRun, _ := cmd.Flags().GetBool("dry-run")
	if dryRun {
		fmt.Fprintln(cmd.ErrOrStderr(), "Read-only preview; no workspace changes.")
		return printSkillPackageRemovalPreview(cmd, preview)
	}
	deleting := cmd.Name() == "delete"
	if deleting {
		if preview["can_delete"] != true {
			if err := printSkillPackageRemovalPreview(cmd, preview); err != nil {
				return err
			}
			return fmt.Errorf("package contains skills you cannot delete; nothing was deleted")
		}
		yes, _ := cmd.Flags().GetBool("yes")
		if !yes {
			pkg, err := requestSkillPackage(cmd, client, path, nil)
			if err != nil {
				return err
			}
			if err := validateSkillPackageResponse(pkg, "get"); err != nil {
				return err
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "Delete package %s? This permanently deletes %d managed skills and removes %d agent bindings; it cannot be undone. [y/N] ", skillPackageRefName(pkg), len(preview["skill_ids"].([]any)), len(preview["affected_agents"].([]any)))
			answer, readErr := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
			answer = strings.TrimSpace(strings.ToLower(answer))
			if answer != "y" && answer != "yes" {
				if answer == "" && readErr != nil {
					return fmt.Errorf("no confirmation received (stdin is not interactive); re-run with --yes to delete without a prompt")
				}
				fmt.Fprintln(cmd.ErrOrStderr(), "Aborted.")
				return nil
			}
		}
	}
	method := http.MethodDelete
	if !deleting {
		method, path = http.MethodPost, path+"/dissolve"
	}
	// The helper creates a fresh context after the confirmation finishes.
	result, err := requestSkillOrganizationWrite(cmd, client, method, path, map[string]any{"preview_id": preview["preview_id"]})
	if err != nil {
		return printSkillOrganizationError(cmd, err)
	}
	if result["deleted"] != deleting || result["dissolved"] != !deleting || !skillPackageNumber(result["skill_count"], 0) || result["skill_count"] != float64(len(preview["skill_ids"].([]any))) {
		return fmt.Errorf("malformed package %s response; result is indeterminate, inspect the package before retrying", cmd.Name())
	}
	return printSkillOrganizationResult(cmd, result)
}

func validateSkillPackageRemovalPreview(preview map[string]any) error {
	invalid := fmt.Errorf("malformed package delete-preview response; check server/CLI compatibility and preview again before writing")
	if !skillPackageStrings(preview, true, "preview_id") {
		return invalid
	}
	if _, ok := preview["can_delete"].(bool); !ok {
		return invalid
	}
	ids, ok := preview["skill_ids"].([]any)
	if !ok {
		return invalid
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !skillFolderUUID(id, false) || seen[id.(string)] {
			return invalid
		}
		seen[id.(string)] = true
	}
	agents, ok := preview["affected_agents"].([]any)
	if !ok {
		return invalid
	}
	for _, v := range agents {
		a, _ := v.(map[string]any)
		if !skillFolderUUID(a["id"], false) || !seen[strVal(a, "skill_id")] || !skillPackageStrings(a, true, "name", "skill_name") {
			return invalid
		}
	}
	return nil
}

func printSkillPackageRemovalPreview(cmd *cobra.Command, preview map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), preview)
	}
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "Can delete: %v\nPreview ID: %s\n", preview["can_delete"], preview["preview_id"])
	rows := [][]string{}
	for _, id := range preview["skill_ids"].([]any) {
		rows = append(rows, []string{id.(string)})
	}
	cli.PrintTable(w, []string{"MANAGED_SKILL_ID"}, rows)
	rows = nil
	for _, v := range preview["affected_agents"].([]any) {
		a := v.(map[string]any)
		rows = append(rows, []string{strVal(a, "id"), strVal(a, "name"), strVal(a, "skill_id"), strVal(a, "skill_name")})
	}
	cli.PrintTable(w, []string{"AGENT_ID", "AGENT", "SKILL_ID", "SKILL"}, rows)
	return nil
}
