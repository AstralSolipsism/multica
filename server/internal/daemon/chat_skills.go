package daemon

import (
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// activeSlashSkillMatches limits the existing slash-link grammar to real Markdown
// links outside quotations/code. A copied issue excerpt is never a selection.
func activeSlashSkillMatches(message string) []slashSkillMatch {
	matches := slashSkillMatches(message)
	if len(matches) == 0 {
		return matches
	}
	source := []byte(message)
	active := make(map[int]bool)
	doc := goldmark.DefaultParser().Parse(text.NewReader(source))
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if node.Kind() == ast.KindBlockquote {
			return ast.WalkSkipChildren, nil
		}
		link, ok := node.(*ast.Link)
		if !ok || !strings.HasPrefix(string(link.Destination), "slash://skill/") {
			return ast.WalkContinue, nil
		}
		_ = ast.Walk(link, func(child ast.Node, entering bool) (ast.WalkStatus, error) {
			if value, ok := child.(*ast.Text); ok && entering {
				for _, match := range matches {
					if match.start <= value.Segment.Start && value.Segment.Stop <= match.end {
						active[match.start] = true
					}
				}
			}
			return ast.WalkContinue, nil
		})
		return ast.WalkSkipChildren, nil
	})
	selected := matches[:0]
	for _, match := range matches {
		if active[match.start] {
			selected = append(selected, match)
		}
	}
	return selected
}

func chatSkillMatches(task Task) []slashSkillMatch {
	if task.ChatSkillMessage == nil {
		// Legacy servers did not distinguish the sender from the originator.
		// Keep their existing hint, but never issue a native command/injection.
		return slashSkillMatches(task.ChatMessage)
	}
	return activeSlashSkillMatches(*task.ChatSkillMessage)
}

func memberSkillTurn(task Task) bool {
	return task.ChatSessionID != "" && !task.ChatIntro && task.ChatSkillMessage != nil && *task.ChatSkillMessage != "" && task.WakeupID == "" && task.IssueID == "" && task.TriggerCommentID == "" && task.AutopilotRunID == "" && task.Agent != nil
}

// selectedMemberSkills is shared by environment preparation and invocation.
// A human originator, quoted link, or a forged label never authorizes installing
// a user-only workspace skill. IDs must resolve in this agent's assigned set.
func selectedMemberSkills(task Task) map[string]bool {
	selected := make(map[string]bool)
	if !memberSkillTurn(task) || !strings.HasSuffix(task.ChatMessage, *task.ChatSkillMessage) {
		return selected
	}
	assigned := make(map[string]bool, len(task.Agent.Skills))
	for _, skill := range task.Agent.Skills {
		assigned[skill.ID] = true
	}
	for _, match := range activeSlashSkillMatches(*task.ChatSkillMessage) {
		if assigned[match.ref.ID] {
			selected[match.ref.ID] = true
		}
	}
	return selected
}

func taskSkillsForEnv(task Task) []execenv.SkillContextForEnv {
	if task.Agent == nil {
		return nil
	}
	skills := convertSkillsForEnv(task.Agent.Skills)
	selected := selectedMemberSkills(task)
	for i := range skills {
		skills[i].ExplicitlySelected = selected[skills[i].ID]
	}
	return skills
}

// buildRuntimePrompt keeps ordinary inputs byte-for-byte unchanged. Only the
// server's authenticated member input can earn a structured invocation; a
// human originator on an issue/agent/system task is insufficient.
func buildRuntimePrompt(task Task, provider string, directories map[string]string, options ...PromptOption) (string, *agent.SkillInvocation) {
	matches := chatSkillMatches(task)
	refs := uniqueSlashSkillRefs(matches)
	options = append(options, func(o *promptOpts) {
		o.skillDirectories = directories
		o.chatSkillRefs = refs
	})
	prompt := BuildPrompt(task, provider, options...)
	eligible := selectedMemberSkills(task)
	if len(eligible) == 0 {
		return prompt, nil
	}
	skillMessage := *task.ChatSkillMessage
	// selectedMemberSkills already verified this authenticated suffix.
	start := len(task.ChatMessage) - len(skillMessage)
	assigned := make(map[string]SkillData, len(task.Agent.Skills))
	for _, skill := range task.Agent.Skills {
		assigned[skill.ID] = skill
	}
	invocation := &agent.SkillInvocation{}
	selected := make(map[string]bool)
	for _, ref := range refs {
		skill, ok := assigned[ref.ID]
		dir := directories[ref.ID]
		if !ok || !eligible[ref.ID] || !filepath.IsAbs(dir) {
			continue
		}
		invocation.Skills = append(invocation.Skills, agent.ExplicitSkill{
			Name: filepath.Base(dir), Directory: dir, Body: execenv.SkillBody(skill.Content),
		})
		selected[ref.ID] = true
	}
	if len(invocation.Skills) == 0 {
		return prompt, nil
	}
	// Strip only selected links in the actual member text. Unknown IDs and
	// quoted links remain visible, and cannot become a leading CLI command.
	user := stripSelectedSkillLinks(skillMessage, matches, selected)
	task.ChatMessage = task.ChatMessage[:start] + user + task.ChatMessage[start+len(skillMessage):]
	invocation.UserMessage = task.ChatMessage
	invocation.Prompt = BuildPrompt(task, provider, options...)
	options = append(options, func(o *promptOpts) { o.omitChatMessage = true })
	invocation.PlatformPrompt = BuildPrompt(task, provider, options...)
	return invocation.FallbackPrompt(), invocation
}

func stripSelectedSkillLinks(message string, matches []slashSkillMatch, selected map[string]bool) string {
	var user strings.Builder
	end := 0
	for _, match := range matches {
		if !selected[match.ref.ID] {
			continue
		}
		user.WriteString(message[end:match.start])
		end = match.end
	}
	user.WriteString(message[end:])
	return user.String()
}
