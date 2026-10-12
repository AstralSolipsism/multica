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

// activeSlashSkillLinks limits the existing slash-link grammar to real Markdown
// links outside quotations/code. A copied issue excerpt is never a selection.
func activeSlashSkillLinks(message string) map[int]bool {
	source := []byte(message)
	matches := slashSkillRe.FindAllStringSubmatchIndex(message, -1)
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
					if match[0] <= value.Segment.Start && value.Segment.Stop <= match[1] {
						active[match[0]] = true
					}
				}
			}
			return ast.WalkContinue, nil
		})
		return ast.WalkSkipChildren, nil
	})
	return active
}

func chatSkillRefs(task Task) []SlashSkillRef {
	if task.ChatSkillMessage == nil {
		// Legacy servers did not distinguish the sender from the originator.
		// Keep their existing hint, but never issue a native command/injection.
		return ExtractSlashSkills(task.ChatMessage)
	}
	message := *task.ChatSkillMessage
	if len(ExtractSlashSkills(message)) == 0 {
		return nil
	}
	active := activeSlashSkillLinks(message)
	var selected strings.Builder
	for _, match := range slashSkillRe.FindAllStringSubmatchIndex(message, -1) {
		if active[match[0]] {
			selected.WriteString(message[match[0]:match[1]])
			selected.WriteByte('\n')
		}
	}
	return ExtractSlashSkills(selected.String())
}

// buildRuntimePrompt keeps ordinary inputs byte-for-byte unchanged. Only the
// server's authenticated member input can earn a structured invocation; a
// human originator on an issue/agent/system task is insufficient.
func buildRuntimePrompt(task Task, provider string, directories map[string]string, options ...PromptOption) (string, *agent.SkillInvocation) {
	options = append(options, func(o *promptOpts) { o.skillDirectories = directories })
	prompt := BuildPrompt(task, provider, options...)
	if task.ChatSessionID == "" || task.ChatIntro || task.ChatSkillMessage == nil || *task.ChatSkillMessage == "" || task.WakeupID != "" || task.IssueID != "" || task.AutopilotRunID != "" || task.Agent == nil {
		return prompt, nil
	}
	skillMessage := *task.ChatSkillMessage
	refs := chatSkillRefs(task)
	if len(refs) == 0 {
		return prompt, nil
	}
	// Direct chat input is a contiguous suffix of the claimed batch; an older
	// or inconsistent server payload must not let this field replace user text.
	start := strings.LastIndex(task.ChatMessage, skillMessage)
	if start < 0 {
		return prompt, nil
	}
	active := activeSlashSkillLinks(skillMessage)
	assigned := make(map[string]SkillData, len(task.Agent.Skills))
	for _, skill := range task.Agent.Skills {
		assigned[skill.ID] = skill
	}
	invocation := &agent.SkillInvocation{}
	selected := make(map[string]bool)
	for _, ref := range refs {
		skill, ok := assigned[ref.ID]
		dir := directories[ref.ID]
		if !ok || !filepath.IsAbs(dir) {
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
	var user strings.Builder
	end := 0
	for _, match := range slashSkillRe.FindAllStringSubmatchIndex(skillMessage, -1) {
		if !active[match[0]] || !selected[skillMessage[match[4]:match[5]]] {
			continue
		}
		user.WriteString(skillMessage[end:match[0]])
		end = match[1]
	}
	user.WriteString(skillMessage[end:])
	options = append(options, func(o *promptOpts) { o.chatSkillRefs = refs })
	task.ChatMessage = task.ChatMessage[:start] + user.String() + task.ChatMessage[start+len(skillMessage):]
	invocation.UserMessage = task.ChatMessage
	invocation.Prompt = BuildPrompt(task, provider, options...)
	options = append(options, func(o *promptOpts) { o.omitChatMessage = true })
	invocation.PlatformPrompt = BuildPrompt(task, provider, options...)
	return invocation.FallbackPrompt(), invocation
}
