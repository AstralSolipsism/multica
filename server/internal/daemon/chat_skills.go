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

// memberSkillText pairs an authenticated human-member input with the active
// matches found inside it. Only the server's own authorship data can put a
// text here; nothing derived from issue bodies, agent/system comments or
// legacy payloads without an author type qualifies.
type memberSkillText struct {
	text    string
	matches []slashSkillMatch
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
	return task.ChatSessionID != "" && !task.ChatIntro && task.ChatSkillMessage != nil && *task.ChatSkillMessage != "" && task.WakeupID == "" && task.IssueID == "" && task.AutopilotRunID == "" && task.Agent != nil
}

// issueMemberSkillTurn reports whether this run is a comment-triggered issue
// task whose explicit skill selections may be honored at all. Wakeups and
// autopilots carry no member comment intent even when they name a trigger
// comment, and quick-create/assignment tasks have no comment to trust.
func issueMemberSkillTurn(task Task) bool {
	return task.IssueID != "" && task.ChatSessionID == "" && task.WakeupID == "" && task.AutopilotRunID == "" &&
		task.TriggerCommentID != "" && task.Agent != nil
}

// memberSkillTexts collects the authenticated member inputs this run may act
// on, in a stable order: a chat turn contributes its direct member message,
// an issue turn contributes its human-authored comments — coalesced comments
// oldest first, then the newest trigger comment. Everything else (agent or
// system authorship, empty author types from legacy payloads, quoted or
// code-span links via activeSlashSkillMatches) is filtered before it can
// reach a SkillInvocation.
func memberSkillTexts(task Task) []memberSkillText {
	if memberSkillTurn(task) {
		return []memberSkillText{{text: *task.ChatSkillMessage, matches: activeSlashSkillMatches(*task.ChatSkillMessage)}}
	}
	if !issueMemberSkillTurn(task) {
		return nil
	}
	var texts []memberSkillText
	for _, cc := range task.CoalescedComments {
		if cc.AuthorType == "member" && cc.Content != "" {
			texts = append(texts, memberSkillText{text: cc.Content, matches: activeSlashSkillMatches(cc.Content)})
		}
	}
	if task.TriggerAuthorType == "member" && task.TriggerCommentContent != "" {
		texts = append(texts, memberSkillText{text: task.TriggerCommentContent, matches: activeSlashSkillMatches(task.TriggerCommentContent)})
	}
	return texts
}

// memberSkillRefs deduplicates the refs of member texts by skill ID, keeping
// first-seen (chronological) order across the merged comments.
func memberSkillRefs(texts []memberSkillText) []SlashSkillRef {
	var matches []slashSkillMatch
	for _, text := range texts {
		matches = append(matches, text.matches...)
	}
	return uniqueSlashSkillRefs(matches)
}

// buildRuntimePrompt keeps ordinary inputs byte-for-byte unchanged. Only the
// server's authenticated member input can earn a structured invocation; a
// human originator on an agent/system/wakeup task is insufficient.
func buildRuntimePrompt(task Task, provider string, directories map[string]string, options ...PromptOption) (string, *agent.SkillInvocation) {
	texts := memberSkillTexts(task)
	var refs []SlashSkillRef
	if len(texts) > 0 {
		refs = memberSkillRefs(texts)
	} else if task.ChatSessionID != "" {
		// Legacy chat hint: refs stay display-only, never an invocation.
		refs = uniqueSlashSkillRefs(chatSkillMatches(task))
	}
	options = append(options, func(o *promptOpts) {
		o.skillDirectories = directories
		o.chatSkillRefs = refs
	})
	prompt := BuildPrompt(task, provider, options...)
	if len(texts) == 0 || len(refs) == 0 {
		return prompt, nil
	}
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
	if task.ChatSessionID != "" {
		return chatRuntimePrompt(task, texts[0], selected, invocation, provider, options...)
	}
	return issueRuntimePrompt(task, texts, selected, invocation, provider, options...)
}

// chatRuntimePrompt finishes a direct chat turn's invocation: the member
// message is a contiguous part of the claimed batch, and only selected links
// inside it are stripped before the prompt is rebuilt.
func chatRuntimePrompt(task Task, source memberSkillText, selected map[string]bool, invocation *agent.SkillInvocation, provider string, options ...PromptOption) (string, *agent.SkillInvocation) {
	skillMessage := source.text
	// Direct chat input is a contiguous suffix of the claimed batch; an older
	// or inconsistent server payload must not let this field replace user text.
	start := strings.LastIndex(task.ChatMessage, skillMessage)
	if start < 0 {
		return BuildPrompt(task, provider, options...), nil
	}
	// Strip only selected links in the actual member text. Unknown IDs and
	// quoted links remain visible, and cannot become a leading CLI command.
	user := stripSelectedSkillLinks(skillMessage, source.matches, selected)
	task.ChatMessage = task.ChatMessage[:start] + user + task.ChatMessage[start+len(skillMessage):]
	invocation.UserMessage = task.ChatMessage
	invocation.Prompt = BuildPrompt(task, provider, options...)
	options = append(options, func(o *promptOpts) { o.omitChatMessage = true })
	invocation.PlatformPrompt = BuildPrompt(task, provider, options...)
	return invocation.FallbackPrompt(), invocation
}

// issueRuntimePrompt finishes a comment-triggered issue turn's invocation.
// Hit links are stripped from the human member comments embedded in the
// comment prompt, and UserMessage carries every member ask of the run —
// including coalesced member comments that carried no skill link — for
// Claude's trailing slash-command block. PlatformPrompt equals the complete
// comment prompt: unlike chat there is no separate user-message section to
// omit, and the issue context, thread metadata and --parent reply routing
// must survive intact.
func issueRuntimePrompt(task Task, texts []memberSkillText, selected map[string]bool, invocation *agent.SkillInvocation, provider string, options ...PromptOption) (string, *agent.SkillInvocation) {
	strip := func(text memberSkillText) string {
		return strings.TrimSpace(stripSelectedSkillLinks(text.text, text.matches, selected))
	}
	// The task value is a copy, but its slice fields share the caller's
	// backing array — the retry path rebuilds from the same task, and a
	// stripped comment there would hide its links from the second pass.
	task.CoalescedComments = append([]CoalescedCommentData(nil), task.CoalescedComments...)
	for i, cc := range task.CoalescedComments {
		if cc.AuthorType == "member" && cc.Content != "" {
			matches := activeSlashSkillMatches(cc.Content)
			task.CoalescedComments[i].Content = stripSelectedSkillLinks(cc.Content, matches, selected)
		}
	}
	if task.TriggerAuthorType == "member" && task.TriggerCommentContent != "" {
		stripped := stripSelectedSkillLinks(task.TriggerCommentContent, activeSlashSkillMatches(task.TriggerCommentContent), selected)
		if strings.TrimSpace(stripped) == "" {
			// A pure skill-capsule comment strips to nothing. The comment
			// prompt treats an empty trigger body as "server could not fetch
			// it", which would silently drop the comment header, edit notes
			// and every coalesced comment — so keep the section alive with a
			// placeholder instead.
			stripped = ""
			options = append(options, func(o *promptOpts) { o.triggerCommentStripped = true })
		}
		task.TriggerCommentContent = stripped
	}
	var user []string
	for _, text := range texts {
		if stripped := strip(text); stripped != "" {
			user = append(user, stripped)
		}
	}
	invocation.UserMessage = strings.Join(user, "\n\n")
	invocation.Prompt = BuildPrompt(task, provider, options...)
	invocation.PlatformPrompt = invocation.Prompt
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
