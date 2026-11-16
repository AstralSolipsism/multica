package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

// Resolve against one workspace read, including full IDs for batch preflight.
// Display is the full path/source; Detail is its unqualified name.
func resolveSkillOrganizationRef(kind, input string, candidates []idCandidate) (resolvedID, error) {
	input = strings.TrimSpace(input)
	matches := []idCandidate{}
	if uuidRegexp.MatchString(input) {
		for _, c := range candidates {
			if strings.EqualFold(c.ID, input) {
				return resolvedID{ID: c.ID, Display: c.Display}, nil
			}
		}
		return resolvedID{}, fmt.Errorf("no %s found with ID %q in this workspace", kind, input)
	}
	for _, c := range candidates {
		if input != "" && (c.Display == input || c.Detail == input) {
			matches = append(matches, c)
		}
	}
	if len(matches) == 1 {
		return resolvedID{ID: matches[0].ID, Display: matches[0].Display}, nil
	}
	if len(matches) > 1 {
		sort.Slice(matches, func(i, j int) bool { return matches[i].ID < matches[j].ID })
		lines := []string{}
		for _, c := range matches {
			lines = append(lines, "  "+c.ID+"  "+c.Display)
		}
		return resolvedID{}, fmt.Errorf("ambiguous %s name %q; matches:\n%s\nUse the full path/source or ID (list --full-id)", kind, input, strings.Join(lines, "\n"))
	}
	prefix, err := normalizeUUIDPrefix(input)
	if err != nil {
		return resolvedID{}, fmt.Errorf("no %s found named %q; resolve %s: %w", kind, input, kind, err)
	}
	for _, c := range candidates {
		if strings.HasPrefix(compactUUID(c.ID), prefix) {
			matches = append(matches, c)
		}
	}
	switch len(matches) {
	case 0:
		return resolvedID{}, fmt.Errorf("no %s found matching id prefix %q; run the list command with --full-id to copy the full UUID", kind, input)
	case 1:
		return resolvedID{ID: matches[0].ID, Display: matches[0].Display}, nil
	default:
		return resolvedID{}, ambiguousIDPrefixError(kind, input, matches)
	}
}

func skillPackageRefName(p map[string]any) string {
	return strVal(p, "owner_repo") + ":" + strVal(p, "subdirectory")
}

func resolveSkillPackageRef(cmd *cobra.Command, client *cli.APIClient, input string) (resolvedID, error) {
	input = strings.TrimSpace(input)
	if skillFolderUUID(input, false) {
		return resolvedID{ID: strings.ToLower(input), Display: input}, nil
	}
	result, err := requestSkillPackage(cmd, client, "/api/skill-packages", nil)
	if err != nil {
		return resolvedID{}, err
	}
	if err := validateSkillPackageResponse(result, "list"); err != nil {
		return resolvedID{}, err
	}
	candidates := []idCandidate{}
	for _, v := range result["packages"].([]any) {
		p := v.(map[string]any)
		if !skillFolderUUID(p["id"], false) {
			return resolvedID{}, fmt.Errorf("malformed package ID")
		}
		candidates = append(candidates, idCandidate{ID: strVal(p, "id"), Display: skillPackageRefName(p), Detail: strVal(p, "owner_repo")})
	}
	return resolveSkillOrganizationRef("package", input, candidates)
}

func readSkillFolderTree(cmd *cobra.Command, client *cli.APIClient) (map[string]any, error) {
	tree, err := requestSkillPackage(cmd, client, "/api/skill-folders", nil)
	if err != nil {
		return nil, err
	}
	return tree, validateSkillFolderResponse(tree, "tree")
}

func readSkillFolderSkills(cmd *cobra.Command, client *cli.APIClient) ([]map[string]any, error) {
	ctx, cancel := cli.APIContext(cmd.Context())
	defer cancel()
	var skills []map[string]any
	if err := client.GetJSON(ctx, "/api/skills", &skills); err != nil {
		return nil, err
	}
	if skills == nil {
		return nil, fmt.Errorf("skill list response must be an array")
	}
	for _, s := range skills {
		if !skillFolderUUID(s["id"], false) || !skillPackageStrings(s, true, "name") {
			return nil, fmt.Errorf("malformed skill list response")
		}
	}
	return skills, nil
}

func skillFolderPaths(tree map[string]any) map[string]string {
	folders := map[string]map[string]any{}
	for _, v := range tree["folders"].([]any) {
		f := v.(map[string]any)
		folders[strVal(f, "id")] = f
	}
	paths := map[string]string{}
	for id := range folders {
		chain := []string{}
		for current := id; current != "" && paths[current] == ""; current = strVal(folders[current], "parent_id") {
			chain = append(chain, current)
		}
		for i := len(chain) - 1; i >= 0; i-- {
			f := folders[chain[i]]
			parent := paths[strVal(f, "parent_id")]
			if parent != "" {
				parent += "/"
			}
			paths[chain[i]] = parent + strVal(f, "name")
		}
	}
	return paths
}

func skillFolderRefs(tree map[string]any) []idCandidate {
	paths := skillFolderPaths(tree)
	refs := []idCandidate{}
	for _, v := range tree["folders"].([]any) {
		f := v.(map[string]any)
		id := strVal(f, "id")
		refs = append(refs, idCandidate{ID: id, Display: paths[id], Detail: strVal(f, "name")})
	}
	return refs
}

func skillFolderKind(f map[string]any) string {
	if f["package_id"] == nil {
		return "custom"
	}
	if strVal(f, "package_path") == "" {
		return "package-root"
	}
	return "package-managed"
}
