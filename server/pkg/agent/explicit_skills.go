package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// ExplicitSkill is a member-selected, assigned skill whose directory was
// materialized by the execution environment. Never construct it from a label.
type ExplicitSkill struct {
	Name      string
	Directory string
	Body      string
}

// SkillInvocation preserves both message parts until the provider has checked
// its native capabilities. Prompt is the complete text input; PlatformPrompt
// excludes UserMessage for Claude's last-text-block slash-command contract.
type SkillInvocation struct {
	Prompt         string
	PlatformPrompt string
	UserMessage    string
	Skills         []ExplicitSkill
}

func injectExplicitSkills(prompt string, skills []ExplicitSkill) string {
	var b strings.Builder
	b.WriteString(prompt)
	for _, skill := range skills {
		fmt.Fprintf(&b, "\n\nThe user explicitly selected this skill in this message: %s\nSkill directory (resolve relative files here): %s\n<selected-skill>\n%s\n</selected-skill>\n", skill.Name, skill.Directory, skill.Body)
	}
	return b.String()
}

// FallbackPrompt is also sent to providers that do not support native user
// invocation (including Hermes ACP and Kimi). No runtime lookup is required.
func (s *SkillInvocation) FallbackPrompt() string {
	return injectExplicitSkills(s.Prompt, s.Skills)
}

func (s *SkillInvocation) claudeTextBlocks(available map[string]bool) []string {
	if len(s.Skills) == 0 || !available[s.Skills[0].Name] {
		return []string{s.FallbackPrompt()}
	}
	return []string{
		injectExplicitSkills(s.PlatformPrompt, s.Skills[1:]),
		"/" + s.Skills[0].Name + " " + s.UserMessage,
	}
}

func (s *SkillInvocation) codexPrompt(catalog json.RawMessage) string {
	var response struct {
		Data []struct {
			Skills []struct {
				Name    string `json:"name"`
				Path    string `json:"path"`
				Enabled *bool  `json:"enabled"`
			} `json:"skills"`
		} `json:"data"`
	}
	if json.Unmarshal(catalog, &response) != nil {
		return s.FallbackPrompt()
	}
	prompt := s.Prompt
	var fallback []ExplicitSkill
	for _, selected := range s.Skills {
		found := false
		for _, entry := range response.Data {
			for _, skill := range entry.Skills {
				if skill.Name == selected.Name && filepath.Clean(skill.Path) == filepath.Join(selected.Directory, "SKILL.md") && skill.Enabled != nil && *skill.Enabled {
					found = true
				}
			}
		}
		if found {
			prompt += "\n\n$" + selected.Name + "\n"
		} else {
			fallback = append(fallback, selected)
		}
	}
	return injectExplicitSkills(prompt, fallback)
}

func (s *SkillInvocation) antigravityPrompt(supported bool) string {
	if !supported || len(s.Skills) == 0 {
		return s.FallbackPrompt()
	}
	// Print mode expands one leading command. Further selections stay explicit
	// through injection, as they do on Claude.
	return "/" + s.Skills[0].Name + "\n" + injectExplicitSkills(s.Prompt, s.Skills[1:])
}

func slashCommandsDisabled(args ...[]string) bool {
	for _, group := range args {
		for _, arg := range group {
			if arg == "--disable-slash-commands" || strings.HasPrefix(arg, "--disable-slash-commands=") {
				return true
			}
		}
	}
	return false
}

// Probe only on selected-skill turns. Do not cache across executable upgrades
// or infer capabilities from version strings. Failure is an injection fallback.
func supportsAntigravitySlashSkills(ctx context.Context, cfg Config, executable string, opts ExecOptions) bool {
	if slashCommandsDisabled(cfg.LaunchPrefix, opts.ExtraArgs, opts.CustomArgs) {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := cfg.commandAt(executable).exec(probeCtx, "--help")
	cmd.Dir = opts.Cwd
	cmd.Env = buildEnv(cfg.Env)
	cmd.WaitDelay = time.Second
	output := &tailBuffer{max: 128 << 10}
	cmd.Stdout, cmd.Stderr = output, output
	if runOwned(cmd, cfg.Logger) != nil {
		return false
	}
	return strings.Contains(string(output.Bytes()), "--disable-slash-commands")
}
