package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

func init() { skillCmd.AddCommand(newSkillFolderCmd()) }
func newSkillFolderCmd() *cobra.Command {
	group := &cobra.Command{Use: "folder", Short: "Manage and migrate skill organization without changing skill contents"}
	for _, action := range []string{"tree", "export", "migrate"} {
		cmd := &cobra.Command{Use: action, Args: exactArgs(0), RunE: runSkillFolder}
		output := "json"
		switch action {
		case "tree":
			cmd.Short = "Show folders, packages, placements and unimported candidates"
			output = "table"
			cmd.Flags().Bool("full-id", false, "Show full UUIDs")
		case "export":
			cmd.Short = "Export the current workspace's organization snapshot"
			cmd.Flags().String("output-file", "", "Write the JSON snapshot to this file")
		case "migrate":
			cmd.Short = "Preview a metadata-only migration; --apply explicitly commits it"
			cmd.Long = "Preview by default. Source and target workspace access are checked separately.\nNo skill content, files, history or agent bindings are modified.\nFailed writes are never retried automatically; preview again before applying."
			cmd.Flags().String("from-file", "", "Read an exported organization snapshot")
			cmd.Flags().String("from-workspace", "", "Export from this workspace UUID using the same credentials")
			cmd.Flags().Bool("dry-run", false, "Read-only preview (the default)")
			cmd.Flags().Bool("apply", false, "Apply the migration atomically")
			cmd.Flags().String("preview-id", "", "Apply a previously reviewed --from-file snapshot and token")
			cmd.MarkFlagsMutuallyExclusive("from-file", "from-workspace")
			cmd.MarkFlagsOneRequired("from-file", "from-workspace")
			cmd.MarkFlagsMutuallyExclusive("dry-run", "apply")
		}
		cmd.Flags().String("output", output, "Output format: table or json (export: json only)")
		group.AddCommand(cmd)
	}
	addSkillFolderManagement(group)
	return group
}
func runSkillFolder(cmd *cobra.Command, _ []string) error {
	output, _ := cmd.Flags().GetString("output")
	if output != "json" && output != "table" || cmd.Name() == "export" && output != "json" {
		return fmt.Errorf("unsupported --output; export requires json, tree/migrate accept table or json")
	}
	fromFile, _ := cmd.Flags().GetString("from-file")
	fromWorkspace, _ := cmd.Flags().GetString("from-workspace")
	apply, _ := cmd.Flags().GetBool("apply")
	token, _ := cmd.Flags().GetString("preview-id")
	if cmd.Flags().Changed("preview-id") && (!apply || fromFile == "" || token == "") {
		return fmt.Errorf("--preview-id requires --apply --from-file and a nonempty token")
	}
	if cmd.Name() == "migrate" && (fromFile == "") == (fromWorkspace == "") {
		return fmt.Errorf("exactly one of --from-file or --from-workspace is required")
	}
	if fromWorkspace != "" && (!uuidRegexp.MatchString(fromWorkspace) || fromWorkspace == "00000000-0000-0000-0000-000000000000") {
		return fmt.Errorf("--from-workspace must be a full nonzero UUID")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if fromWorkspace != "" && strings.EqualFold(fromWorkspace, client.WorkspaceID) {
		return fmt.Errorf("source and target workspace must differ")
	}
	if cmd.Name() == "tree" {
		tree, err := readSkillFolderTree(cmd, client)
		if err != nil {
			return err
		}
		skills, err := readSkillFolderSkills(cmd, client)
		if err != nil {
			return err
		}
		tree["skills"] = skills
		classified := map[string]bool{}
		for _, v := range tree["placements"].([]any) {
			classified[strVal(v.(map[string]any), "skill_id")] = true
		}
		n := 0
		for _, s := range skills {
			if !classified[strVal(s, "id")] {
				n++
			}
		}
		tree["unclassified_count"] = n
		if output == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), tree)
		}
		printSkillFolderTree(cmd, tree, skills)
		return nil
	}
	var snapshot map[string]any
	if fromFile != "" {
		f, err := os.Open(fromFile)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if info.Size() > 8<<20 {
			return fmt.Errorf("snapshot exceeds 8 MiB")
		}
		d := json.NewDecoder(io.LimitReader(f, (8<<20)+1))
		if err = d.Decode(&snapshot); err != nil {
			return fmt.Errorf("read snapshot: %w", err)
		}
		if d.Decode(new(any)) != io.EOF {
			return fmt.Errorf("snapshot must contain exactly one JSON document (maximum 8 MiB)")
		}
	} else {
		source := *client
		if fromWorkspace != "" {
			source.WorkspaceID = fromWorkspace
		}
		snapshot, err = requestSkillPackage(cmd, &source, "/api/skill-folders/snapshot", nil)
		if err != nil {
			return err
		}
	}
	if err := validateSkillFolderResponse(snapshot, "snapshot"); err != nil {
		return err
	}
	if cmd.Name() == "export" {
		filename, _ := cmd.Flags().GetString("output-file")
		if filename == "" {
			return cli.PrintJSON(cmd.OutOrStdout(), snapshot)
		}
		b, err := json.MarshalIndent(snapshot, "", "  ")
		if err != nil {
			return err
		}
		if err = os.WriteFile(filename, append(b, '\n'), 0600); err != nil {
			return err
		}
		fmt.Fprintln(cmd.ErrOrStderr(), "Organization snapshot written to", filename)
		return nil
	}
	body := map[string]any{"snapshot": snapshot}
	if token == "" {
		preview, err := requestSkillPackage(cmd, client, "/api/skill-folders/migrate/preview", body)
		if err != nil {
			return err
		}
		if err = validateSkillFolderResponse(preview, "preview"); err != nil {
			return err
		}
		if !apply || preview["can_apply"] != true {
			if err = printSkillMigration(cmd, preview); err != nil {
				return err
			}
			if preview["can_apply"] != true {
				return fmt.Errorf("migration has blocking conflicts; nothing was applied")
			}
			fmt.Fprintln(cmd.ErrOrStderr(), "Read-only preview. Use --apply to commit this migration.")
			return nil
		}
		token = strVal(preview, "preview_id")
	}
	body["preview_id"] = token
	result, err := requestSkillPackage(cmd, client, "/api/skill-folders/migrate/apply", body)
	if err != nil {
		return err
	}
	if err = validateSkillFolderResponse(result, "apply"); err != nil {
		return err
	}
	if err = printSkillMigration(cmd, result); err != nil {
		return err
	}
	if result["can_apply"] != true {
		return fmt.Errorf("migration was not applied")
	}
	return nil
}
func skillFolderUUID(value any, nullable bool) bool {
	if value == nil {
		return nullable
	}
	s, ok := value.(string)
	return ok && uuidRegexp.MatchString(s) && s != "00000000-0000-0000-0000-000000000000"
}
func skillFolderNullableString(m map[string]any, key string) bool {
	v, exists := m[key]
	_, isString := v.(string)
	return exists && (v == nil || isString)
}
func validateSkillFolderResponse(result map[string]any, kind string) error {
	invalid := func(field string) error {
		return fmt.Errorf("skill folder %s response has malformed or missing %s; check server/CLI compatibility and preview again before writing", kind, field)
	}
	if result == nil {
		return invalid("object")
	}
	snapshot, tree := kind == "snapshot", kind == "tree"
	if snapshot {
		if result["schema_version"] != float64(1) || !skillFolderUUID(result["source_workspace_id"], false) {
			return invalid("schema_version/source_workspace_id")
		}
		if _, err := time.Parse(time.RFC3339, strVal(result, "exported_at")); err != nil {
			return invalid("exported_at")
		}
	}
	for _, key := range []string{"folders", "packages", "placements"} {
		rows, ok := result[key].([]any)
		if !ok {
			return invalid(key)
		}
		seen := map[string]bool{}
		for _, v := range rows {
			m, ok := v.(map[string]any)
			if !ok {
				return invalid(key + " item")
			}
			idKey := "id"
			if key == "placements" {
				idKey = "skill_id"
			}
			nullable := !snapshot && !tree && key == "placements" && (m["action"] == "skipped" || m["action"] == "conflict")
			if !skillFolderUUID(m[idKey], nullable) {
				return invalid(key + " identity")
			}
			id := strVal(m, idKey)
			if id != "" && seen[id] && (snapshot || tree) {
				return invalid("duplicate " + key)
			}
			seen[id] = true
			switch key {
			case "folders":
				if !skillPackageStrings(m, true, "name") || !skillFolderUUID(m["parent_id"], true) || !skillFolderUUID(m["package_id"], true) || !skillFolderNullableString(m, "package_path") || (m["package_id"] == nil) != (m["package_path"] == nil) {
					return invalid("folder fields")
				}
			case "packages":
				if !skillPackageStrings(m, true, "owner_repo", "source_url", "ref") || !skillPackageStrings(m, false, "subdirectory") || !skillFolderUUID(m["root_folder_id"], false) {
					return invalid("package fields")
				}
				candidates, ok := m["candidates"].([]any)
				if !ok {
					return invalid("candidates")
				}
				for _, c := range candidates {
					c, _ := c.(map[string]any)
					if !skillPackageStrings(c, false, "path", "name") {
						return invalid("candidate fields")
					}
				}
			case "placements":
				if !skillFolderUUID(m["folder_id"], false) || !skillFolderUUID(m["package_id"], true) || !skillFolderNullableString(m, "source_path") || (m["package_id"] == nil) != (m["source_path"] == nil) {
					return invalid("placement fields")
				}
				if snapshot {
					s := nestedMap(m, "skill")
					if !skillPackageStrings(s, true, "name", "digest") {
						return invalid("placement skill")
					}
				}
			}
			if !snapshot && !tree {
				sourceKey := "source_id"
				if key == "placements" {
					sourceKey = "source_skill_id"
				}
				if !skillFolderUUID(m[sourceKey], false) {
					return invalid("plan source identity")
				}
				actions := map[string]bool{"create": true, "reuse": true, "update": true}
				if key == "placements" {
					actions = map[string]bool{"place": true, "move": true, "unchanged": true, "skipped": true, "conflict": true}
				}
				if !actions[strVal(m, "action")] {
					return invalid("plan action")
				}
				if m["action"] == "conflict" && result["can_apply"] == true {
					return invalid("conflicting plan")
				}
			}
		}
	}
	if snapshot || tree {
		parents := map[string]string{}
		children := map[string][]string{}
		for _, v := range result["folders"].([]any) {
			f := v.(map[string]any)
			id, parent := strVal(f, "id"), strVal(f, "parent_id")
			parents[id] = parent
			children[parent] = append(children[parent], id)
		}
		for _, parent := range parents {
			if _, ok := parents[parent]; parent != "" && !ok {
				return invalid("folder parent")
			}
		}
		ordered := append([]string{}, children[""]...)
		for i := 0; i < len(ordered); i++ {
			ordered = append(ordered, children[ordered[i]]...)
		}
		if len(ordered) != len(parents) {
			return invalid("cyclic folders")
		}
		for _, v := range result["placements"].([]any) {
			if _, ok := parents[strVal(v.(map[string]any), "folder_id")]; !ok {
				return invalid("placement folder")
			}
		}
	}
	if !snapshot && !tree {
		can, ok := result["can_apply"].(bool)
		if !ok {
			return invalid("can_apply")
		}
		conflicts, ok := result["conflicts"].([]any)
		if !ok || can != (len(conflicts) == 0) {
			return invalid("conflicts")
		}
		for _, c := range conflicts {
			c, _ := c.(map[string]any)
			if !skillPackageStrings(c, true, "kind", "code", "message") {
				return invalid("conflict item")
			}
		}
		summary := nestedMap(result, "summary")
		for _, key := range []string{"create", "reuse", "update", "place", "move", "unchanged", "skipped", "conflicts", "target_only_skills", "target_only_folders", "target_only_packages", "target_only_placements"} {
			if !skillPackageNumber(summary[key], 0) {
				return invalid("summary." + key)
			}
		}
		if summary["conflicts"] != float64(len(conflicts)) {
			return invalid("conflict count")
		}
		if kind == "preview" && !skillPackageStrings(result, true, "preview_id") {
			return invalid("preview_id")
		}
		if _, ok := result["changed"].(bool); !ok {
			return invalid("changed")
		}
	}
	return nil
}
func printSkillMigration(cmd *cobra.Command, result map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" || result["can_apply"] != true {
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
	rows := [][]string{}
	for _, kind := range []string{"folders", "packages", "placements"} {
		for _, v := range result[kind].([]any) {
			m := v.(map[string]any)
			name := strVal(m, "name")
			if kind == "packages" {
				name = strVal(m, "owner_repo")
			}
			if kind == "placements" {
				name = strVal(nestedMap(m, "skill"), "name")
			}
			rows = append(rows, []string{kind, name, strVal(m, "action"), strVal(m, "from_path"), strVal(m, "to_path"), strVal(m, "code")})
		}
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"KIND", "NAME", "ACTION", "FROM", "TO", "CODE"}, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "Can apply: %v; changed: %v\n", result["can_apply"], result["changed"])
	if token := strVal(result, "preview_id"); token != "" {
		fmt.Fprintln(cmd.OutOrStdout(), "Preview ID:", token)
	}
	return nil
}
func printSkillFolderTree(cmd *cobra.Command, tree map[string]any, skills []map[string]any) {
	w := cmd.OutOrStdout()
	fullID, _ := cmd.Flags().GetBool("full-id")
	names := map[string]string{}
	for _, s := range skills {
		names[strVal(s, "id")] = strVal(s, "name")
	}
	children := map[string][]map[string]any{}
	placements := map[string][]map[string]any{}
	imported := map[string]bool{}
	classified := map[string]bool{}
	for _, v := range tree["folders"].([]any) {
		f := v.(map[string]any)
		parent := strVal(f, "parent_id")
		children[parent] = append(children[parent], f)
	}
	for _, v := range tree["placements"].([]any) {
		p := v.(map[string]any)
		folder := strVal(p, "folder_id")
		placements[folder] = append(placements[folder], p)
		classified[strVal(p, "skill_id")] = true
		if p["package_id"] != nil {
			imported[strVal(p, "package_id")+"\x00"+strVal(p, "source_path")] = true
		}
	}
	gray := map[string][]map[string]any{}
	managed := map[string]string{}
	for _, v := range tree["folders"].([]any) {
		f := v.(map[string]any)
		if f["package_id"] != nil {
			managed[strVal(f, "package_id")+"\x00"+strVal(f, "package_path")] = strVal(f, "id")
		}
	}
	for _, v := range tree["packages"].([]any) {
		p := v.(map[string]any)
		candidates := p["candidates"].([]any)
		prefix := skillFolderCandidatePrefix(candidates)
		for _, v := range candidates {
			c := v.(map[string]any)
			if imported[strVal(p, "id")+"\x00"+strVal(c, "path")] {
				continue
			}
			relative := strings.TrimPrefix(strings.TrimPrefix(skillFolderCandidateParent(strVal(c, "path")), prefix), "/")
			folder := managed[strVal(p, "id")+"\x00"+relative]
			if relative == "" || folder == "" {
				folder = strVal(p, "root_folder_id")
			}
			gray[folder] = append(gray[folder], c)
		}
	}
	for _, folders := range children {
		sort.Slice(folders, func(i, j int) bool { return strVal(folders[i], "name") < strVal(folders[j], "name") })
	}
	for _, items := range placements {
		sort.Slice(items, func(i, j int) bool { return names[strVal(items[i], "skill_id")] < names[strVal(items[j], "skill_id")] })
	}
	for _, items := range gray {
		sort.Slice(items, func(i, j int) bool { return strVal(items[i], "name") < strVal(items[j], "name") })
	}
	type entry struct {
		folder map[string]any
		depth  int
	}
	stack := []entry{}
	for _, f := range children[""] {
		stack = append(stack, entry{f, 0})
	}
	seen := map[string]bool{}
	for len(stack) > 0 {
		item := stack[0]
		stack = stack[1:]
		f := item.folder
		id := strVal(f, "id")
		if seen[id] {
			continue
		}
		seen[id] = true
		indent := strings.Repeat("  ", item.depth)
		mark := ""
		switch skillFolderKind(f) {
		case "package-root":
			mark = " [package]"
		case "package-managed":
			mark = " [managed]"
		}
		fmt.Fprintf(w, "%s%s (%s)%s\n", indent, strVal(f, "name"), displayID(id, fullID), mark)
		for _, p := range placements[id] {
			mark := ""
			if f["package_id"] != nil && p["package_id"] == nil {
				mark = " [detached]"
			}
			fmt.Fprintf(w, "%s  %s (%s)%s\n", indent, names[strVal(p, "skill_id")], displayID(strVal(p, "skill_id"), fullID), mark)
		}
		for _, c := range gray[id] {
			fmt.Fprintf(w, "%s  [not imported] %s (%s)\n", indent, strVal(c, "name"), skillPackageDisplayPath(c))
		}
		kids := children[id]
		next := []entry{}
		for _, child := range kids {
			next = append(next, entry{child, item.depth + 1})
		}
		stack = append(next, stack...)
	}
	fmt.Fprintf(w, "Unclassified: %v\n", tree["unclassified_count"])
	for _, s := range skills {
		if !classified[strVal(s, "id")] {
			fmt.Fprintf(w, "  %s (%s)\n", strVal(s, "name"), displayID(strVal(s, "id"), fullID))
		}
	}
}

// Mirror the package wire contract: managed paths omit the common candidate parent.
func skillFolderCandidateParent(candidate string) string {
	parent := path.Dir(candidate)
	if parent == "." {
		return ""
	}
	return parent
}

func skillFolderCandidatePrefix(candidates []any) string {
	if len(candidates) == 0 {
		return ""
	}
	prefix := skillFolderCandidateParent(strVal(candidates[0].(map[string]any), "path"))
	for _, v := range candidates[1:] {
		parent := skillFolderCandidateParent(strVal(v.(map[string]any), "path"))
		for prefix != "" && parent != prefix && !strings.HasPrefix(parent, prefix+"/") {
			prefix = skillFolderCandidateParent(prefix)
		}
	}
	return prefix
}
