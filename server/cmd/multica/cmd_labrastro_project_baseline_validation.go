package main

import (
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

func baselineNumber(s string) (int32, error) {
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil || n < 1 {
		return 0, baselineFailure(2, "revision number must be a positive 32-bit integer")
	}
	return int32(n), nil
}

func baselineValidate(cmd *cobra.Command) error {
	action, output := cmd.Name(), mustString(cmd, "output")
	valid := map[string][]string{
		"tree": {"text", "json"}, "get": {"markdown", "text", "json"}, "create": {"text", "json"},
		"write": {"text", "json"}, "rename": {"text", "json"}, "move": {"text", "json"},
		"archive": {"text", "json"}, "restore": {"text", "json"}, "history": {"text", "json"},
		"diff": {"text", "json"}, "rollback": {"text", "json"}, "activity": {"text", "json"},
		"search": {"text", "json"}, "export": {"text", "json"},
	}
	if !contains(valid[action], output) {
		return baselineFailure(2, "unsupported --output format")
	}
	needNumber := func(flag string) (int32, error) {
		value := mustString(cmd, flag)
		if value == "" {
			return 0, baselineFailure(2, "--%s is required", flag)
		}
		return baselineNumber(value)
	}
	optNumber := func(flag string) (int32, error) {
		if !cmd.Flags().Changed(flag) {
			return 0, nil
		}
		return baselineNumber(mustString(cmd, flag))
	}
	switch action {
	case "get":
		if index, _ := cmd.Flags().GetBool("index"); index {
			return baselineFailure(2, "--index is retired: use `multica project baseline tree <project-id>` for the page outline")
		}
		if candidate, _ := cmd.Flags().GetBool("candidate"); candidate {
			return baselineFailure(2, "--candidate is retired: writes publish immediately; use `history` and `diff` instead")
		}
		if chapter := mustString(cmd, "chapter"); chapter != "" {
			return baselineFailure(2, "--chapter is retired: use `get --page %s`; module:<name> becomes --page <name>, or run `tree` first when the slug was hashed or renamed", baselineChapterHint(chapter))
		}
		section := mustString(cmd, "section")
		if cmd.Flags().Changed("section") && strings.TrimSpace(section) == "" {
			return baselineFailure(2, "--section must not be empty")
		}
		if cmd.Flags().Changed("revision") {
			if strings.Contains(mustString(cmd, "revision"), ":") {
				return baselineFailure(2, "--revision chapter:number is retired: use `get --page <slug> --revision <n>` (built-in chapter keys are slugs)")
			}
			if _, err := needNumber("revision"); err != nil {
				return err
			}
			if mustString(cmd, "page") == "" {
				return baselineFailure(2, "--revision requires --page")
			}
		}
	case "create":
		if strings.TrimSpace(mustString(cmd, "title")) == "" {
			return baselineFailure(2, "--title is required")
		}
	case "write":
		if mustString(cmd, "page") == "" {
			return baselineFailure(2, "--page is required")
		}
		if _, err := needNumber("base"); err != nil {
			return err
		}
		section, deleting := mustString(cmd, "section"), mustString(cmd, "delete-section")
		if cmd.Flags().Changed("section") && strings.TrimSpace(section) == "" || cmd.Flags().Changed("delete-section") && strings.TrimSpace(deleting) == "" {
			return baselineFailure(2, "--section and --delete-section must not be empty")
		}
		if section != "" && deleting != "" {
			return baselineFailure(2, "use --section or --delete-section, not both")
		}
		if mustString(cmd, "content-file") == "" && deleting == "" {
			return baselineFailure(2, "--content-file is required (or use --delete-section)")
		}
	case "rename", "move", "archive", "restore", "history", "diff", "rollback":
		if mustString(cmd, "page") == "" {
			return baselineFailure(2, "--page is required")
		}
		switch action {
		case "rename":
			if _, err := needNumber("base"); err != nil {
				return err
			}
			if mustString(cmd, "title") == "" && mustString(cmd, "slug") == "" {
				return baselineFailure(2, "specify --title and/or --slug")
			}
		case "move":
			if _, err := needNumber("base"); err != nil {
				return err
			}
			parent, root := mustString(cmd, "parent"), cmd.Flags().Changed("root")
			first, _ := cmd.Flags().GetBool("first")
			if parent != "" && root || first && root || parent == "" && !root && !cmd.Flags().Changed("after") && !first {
				return baselineFailure(2, "specify --parent <slug>, --root, --after <slug> or --first")
			}
		case "archive", "restore", "rollback":
			if _, err := needNumber("base"); err != nil {
				return err
			}
			if action == "rollback" {
				if _, err := needNumber("to"); err != nil {
					return err
				}
			}
		case "history":
			if _, err := optNumber("limit"); err != nil {
				return err
			}
			if _, err := optNumber("before"); err != nil {
				return err
			}
		case "diff":
			if chapter := mustString(cmd, "chapter"); chapter != "" {
				return baselineFailure(2, "--chapter is retired: use `diff --page %s`; module:<name> becomes --page <name>, or run `tree` first", baselineChapterHint(chapter))
			}
			if _, err := needNumber("from"); err != nil {
				return err
			}
			if _, err := optNumber("to"); err != nil {
				return err
			}
		}
	case "export":
		if cmd.Flags().Changed("single-file") && (mustString(cmd, "single-file") == "" || cmd.Flags().Changed("dir")) {
			return baselineFailure(2, "use either a non-empty --single-file or --dir")
		}
		if mustString(cmd, "dir") == "" {
			return baselineFailure(2, "--dir must not be empty")
		}
	}
	return nil
}

// baselineChapterHint maps an old --chapter value to its closest new --page
// argument for migration hints.
func baselineChapterHint(chapter string) string {
	if slug, ok := strings.CutPrefix(chapter, "module:"); ok {
		return slug
	}
	return chapter
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
