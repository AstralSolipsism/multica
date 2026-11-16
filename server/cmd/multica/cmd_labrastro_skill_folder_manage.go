package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func addSkillFolderManagement(group *cobra.Command) {
	for _, action := range []string{"list", "get", "create", "update", "delete", "move-skill", "detach-skill"} {
		cmd := &cobra.Command{Use: action + " <folder>", Args: exactArgs(1), RunE: runSkillFolderManagement}
		output := "json"
		switch action {
		case "list":
			cmd.Use, cmd.Short, cmd.Args = "list", "List folders with their full paths and kinds", exactArgs(0)
			cmd.Flags().Bool("full-id", false, "Show full UUIDs")
			output = "table"
		case "get":
			cmd.Short = "Get a folder and its direct contents counts"
		case "create":
			cmd.Use, cmd.Short, cmd.Args = "create", "Create a custom folder", exactArgs(0)
			cmd.Flags().String("name", "", "Folder name (required)")
			cmd.MarkFlagRequired("name")
			cmd.Flags().String("parent", "", "Parent folder ID, path, name, or UUID prefix")
		case "update":
			cmd.Short = "Rename or move a custom folder or package root"
			cmd.Flags().String("name", "", "New folder name")
			cmd.Flags().String("parent", "", "Parent folder ID, path, name, or UUID prefix")
			cmd.Flags().Bool("root", false, "Move to the root")
			cmd.MarkFlagsMutuallyExclusive("parent", "root")
		case "delete":
			cmd.Short = "Delete a custom folder, promoting its direct contents one level"
		case "move-skill":
			cmd.Use, cmd.Short, cmd.Args = "move-skill <skill>...", "Move skills after resolving the entire selection", minimumArgs(1)
			cmd.Long = "Resolve all skills and the destination before writing; duplicate skills are moved once.\nWrites are sequential, stop on the first failure, and are never retried.\nA partial failure prints a JSON report of completed skill_ids and the failed item."
			cmd.Flags().String("folder", "", "Destination folder ID, path, name, or UUID prefix")
			cmd.Flags().Bool("root", false, "Move to Unclassified")
			cmd.MarkFlagsMutuallyExclusive("folder", "root")
			cmd.MarkFlagsOneRequired("folder", "root")
		case "detach-skill":
			cmd.Use, cmd.Short = "detach-skill <skill>", "Detach a skill from its package, preserving its folder"
		}
		cmd.Flags().String("output", output, "Output format: table or json")
		group.AddCommand(cmd)
	}
}

func runSkillFolderManagement(cmd *cobra.Command, args []string) error {
	output, _ := cmd.Flags().GetString("output")
	if output != "json" && output != "table" {
		return fmt.Errorf("--output must be table or json")
	}
	action := cmd.Name()
	root, _ := cmd.Flags().GetBool("root")
	if action == "update" && !cmd.Flags().Changed("name") && !cmd.Flags().Changed("parent") && !root {
		return fmt.Errorf("no fields to update; use --name, --parent, or --root")
	}
	if action == "move-skill" && !cmd.Flags().Changed("folder") && !root {
		return fmt.Errorf("one of --folder or --root is required")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if action == "detach-skill" || action == "move-skill" {
		return runSkillFolderPlacements(cmd, client, args)
	}
	tree, err := readSkillFolderTree(cmd, client)
	if err != nil {
		return err
	}
	refs := skillFolderRefs(tree)
	if action == "list" {
		if output == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), tree["folders"])
		}
		fullID, _ := cmd.Flags().GetBool("full-id")
		rows := [][]string{}
		for i, v := range tree["folders"].([]any) {
			f := v.(map[string]any)
			rows = append(rows, []string{displayID(refs[i].ID, fullID), strVal(f, "name"), refs[i].Display, skillFolderKind(f)})
		}
		cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "PATH", "KIND"}, rows)
		return nil
	}
	var folder map[string]any
	var ref resolvedID
	if action != "create" {
		ref, err = resolveSkillOrganizationRef("folder", args[0], refs)
		if err != nil {
			return err
		}
		for _, v := range tree["folders"].([]any) {
			if f := v.(map[string]any); f["id"] == ref.ID {
				folder = f
			}
		}
	}
	if action == "get" {
		if output == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), folder)
		}
		folders, skills := 0, 0
		for _, v := range tree["folders"].([]any) {
			if v.(map[string]any)["parent_id"] == ref.ID {
				folders++
			}
		}
		for _, v := range tree["placements"].([]any) {
			if v.(map[string]any)["folder_id"] == ref.ID {
				skills++
			}
		}
		cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "PATH", "KIND", "PARENT_ID", "PACKAGE_ID", "FOLDERS", "SKILLS"}, [][]string{{ref.ID, strVal(folder, "name"), ref.Display, skillFolderKind(folder), strVal(folder, "parent_id"), strVal(folder, "package_id"), fmt.Sprint(folders), fmt.Sprint(skills)}})
		return nil
	}
	body := map[string]any{}
	if cmd.Flags().Changed("name") {
		body["name"], _ = cmd.Flags().GetString("name")
	}
	if cmd.Flags().Changed("parent") {
		parent, _ := cmd.Flags().GetString("parent")
		resolved, err := resolveSkillOrganizationRef("folder", parent, refs)
		if err != nil {
			return err
		}
		body["parent_id"] = resolved.ID
	} else if root {
		body["parent_id"] = ""
	}
	method, path := http.MethodPost, "/api/skill-folders"
	if action == "update" {
		method, path = http.MethodPatch, path+"/"+ref.ID
	} else if action == "delete" {
		method, path, body = http.MethodDelete, path+"/"+ref.ID, nil
	}
	result, err := requestSkillOrganizationWrite(cmd, client, method, path, body)
	if err != nil {
		return printSkillOrganizationError(cmd, err)
	}
	if action == "delete" {
		if result["deleted"] != true {
			return fmt.Errorf("malformed folder delete response; inspect the tree before retrying")
		}
	} else if !skillFolderUUID(result["id"], false) || !skillPackageStrings(result, true, "name") {
		return fmt.Errorf("malformed folder response; inspect the tree before retrying")
	}
	return printSkillOrganizationResult(cmd, result)
}

func runSkillFolderPlacements(cmd *cobra.Command, client *cli.APIClient, args []string) error {
	folderID := ""
	if cmd.Flags().Changed("folder") {
		tree, err := readSkillFolderTree(cmd, client)
		if err != nil {
			return err
		}
		input, _ := cmd.Flags().GetString("folder")
		ref, err := resolveSkillOrganizationRef("folder", input, skillFolderRefs(tree))
		if err != nil {
			return err
		}
		folderID = ref.ID
	}
	skills, err := readSkillFolderSkills(cmd, client)
	if err != nil {
		return err
	}
	candidates := []idCandidate{}
	for _, s := range skills {
		candidates = append(candidates, idCandidate{ID: strVal(s, "id"), Display: strVal(s, "name")})
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, input := range args {
		ref, err := resolveSkillOrganizationRef("skill", input, candidates)
		if err != nil {
			return err
		}
		if !seen[ref.ID] {
			ids = append(ids, ref.ID)
			seen[ref.ID] = true
		}
	}
	updated := []string{}
	var target any
	if folderID != "" {
		target = folderID
	}
	for _, id := range ids {
		method, path := http.MethodPut, "/api/skill-placements/"+id
		body := map[string]any{"folder_id": folderID}
		if cmd.Name() == "detach-skill" {
			method, path, body = http.MethodPost, path+"/detach", nil
		}
		result, err := requestSkillOrganizationWrite(cmd, client, method, path, body)
		if err == nil && result["updated"] != true {
			err = fmt.Errorf("malformed placement response; inspect the tree before retrying")
		}
		if err != nil {
			failure := map[string]any{"skill_id": id, "error": err.Error()}
			var httpErr *cli.HTTPError
			if errors.As(err, &httpErr) {
				failure["status"] = httpErr.StatusCode
				if detail := skillOrganizationServerError(err); detail != nil {
					failure["response"] = detail
				}
			}
			report := map[string]any{"updated": false, "folder_id": target, "skill_ids": updated, "failed": failure}
			if printErr := cli.PrintJSON(cmd.OutOrStdout(), report); printErr != nil {
				return printErr
			}
			return fmt.Errorf("skill %s failed after %d completed writes; inspect the report before retrying: %w", id, len(updated), err)
		}
		updated = append(updated, id)
	}
	if cmd.Name() == "detach-skill" {
		return printSkillOrganizationResult(cmd, map[string]any{"skill_id": ids[0], "updated": true})
	}
	return printSkillOrganizationResult(cmd, map[string]any{"updated": true, "folder_id": target, "skill_ids": updated})
}

func requestSkillOrganizationWrite(cmd *cobra.Command, client *cli.APIClient, method, path string, body map[string]any) (map[string]any, error) {
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	var result map[string]any
	var err error
	switch method {
	case http.MethodPost:
		err = client.PostJSON(ctx, path, body, &result)
	case http.MethodPatch:
		err = client.PatchJSON(ctx, path, body, &result)
	case http.MethodPut:
		err = client.PutJSON(ctx, path, body, &result)
	case http.MethodDelete:
		if body == nil {
			err = client.DeleteJSONResponse(ctx, path, &result)
		} else {
			// The upstream client exposes body and response separately. Inject
			// the body on a private client copy, retaining its headers and errors.
			data, e := json.Marshal(body)
			if e != nil {
				return nil, e
			}
			copyClient, copyHTTP := *client, *client.HTTPClient
			copyHTTP.Transport = skillPackageDeleteBody{base: client.HTTPClient.Transport, body: string(data)}
			copyClient.HTTPClient = &copyHTTP
			err = copyClient.DeleteJSONResponse(ctx, path, &result)
		}
	default:
		return nil, fmt.Errorf("unsupported skill organization method %s", method)
	}
	return result, err
}

type skillPackageDeleteBody struct {
	base http.RoundTripper
	body string
}

func (t skillPackageDeleteBody) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	if copy.Method == http.MethodDelete {
		copy.Body = io.NopCloser(strings.NewReader(t.body))
		copy.ContentLength = int64(len(t.body))
		copy.Header.Set("Content-Type", "application/json")
	}
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(copy)
}

func skillOrganizationServerError(err error) map[string]any {
	var httpErr *cli.HTTPError
	var result map[string]any
	if errors.As(err, &httpErr) && !httpErr.BodyTruncated {
		if json.Unmarshal([]byte(httpErr.Body), &result) != nil {
			return nil
		}
	}
	return result
}

func printSkillOrganizationError(cmd *cobra.Command, err error) error {
	if result := skillOrganizationServerError(err); result != nil {
		if printErr := cli.PrintJSON(cmd.OutOrStdout(), result); printErr != nil {
			return printErr
		}
	}
	return cli.WithUserMessage("Skill organization write failed; inspect the tree/preview before retrying. "+cli.FormatError(err, false), err)
}

func printSkillOrganizationResult(cmd *cobra.Command, result map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
	rows := [][]string{}
	for _, key := range []string{"id", "name", "parent_id", "package_id", "deleted", "dissolved", "skill_count", "updated", "folder_id", "skill_id", "skill_ids"} {
		if value, ok := result[key]; ok {
			rows = append(rows, []string{key, fmt.Sprint(value)})
		}
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"FIELD", "VALUE"}, rows)
	return nil
}
