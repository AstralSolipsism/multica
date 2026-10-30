// Package engineering computes deterministic baseline diffs without model calls.
package engineering

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var Chapters = []string{"overview", "domain_rules", "architecture", "exclusions_and_risks"}

var prefixes = map[string]string{
	"overview": "Stage", "domain_rules": "Term Rule", "architecture": "ADR Contract", "exclusions_and_risks": "Out Defer Risk",
}

var anchorPattern = regexp.MustCompile(`^### \[(Stage|Term|Rule|ADR|Contract|Out|Defer|Risk)-([^\]\r\n]{1,64})\][ \t]*(.*)$`)
var headingPattern = regexp.MustCompile(`^ {0,3}#{1,3}(?:[ \t]|$)`)
var issueLinkPattern = regexp.MustCompile(`(?:mention://issue/|/issues/)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`)

type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }

type Section struct {
	Anchor string
	Title  string
	Body   string
}

type Change struct {
	Anchor      string `json:"anchor"`
	Title       string `json:"title"`
	Before      string `json:"before,omitempty"`
	After       string `json:"after,omitempty"`
	BeforeChars int    `json:"before_chars,omitempty"`
	AfterChars  int    `json:"after_chars,omitempty"`
}

type Warning struct {
	Code   string `json:"code"`
	Anchor string `json:"anchor"`
}

type Diff struct {
	Chapter            string    `json:"chapter"`
	BaseRevisionNumber int32     `json:"base_revision_number"`
	Added              []Change  `json:"added"`
	Modified           []Change  `json:"modified"`
	Removed            []Change  `json:"removed"`
	UnchangedCount     int       `json:"unchanged_count"`
	Warnings           []Warning `json:"warnings"`
}

func ValidChapter(chapter string) bool { _, ok := prefixes[chapter]; return ok }

func normalize(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if line == "" && (len(out) == 0 || out[len(out)-1] == "") {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n")
}

// Parse ignores fenced examples and ends each anchor at the next H1-H3 heading.
func Parse(chapter, content string) ([]Section, error) {
	if !ValidChapter(chapter) {
		return nil, &Error{"baseline_anchor_invalid"}
	}
	if len(content) > 65536 {
		return nil, &Error{"baseline_too_large"}
	}
	if !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return nil, &Error{"baseline_anchor_invalid"}
	}
	sections := []Section{{Anchor: "_preamble"}}
	bodies := []*strings.Builder{new(strings.Builder)}
	seen := map[string]bool{}
	current := 0
	unanchored := -1
	fence := ""
	for _, line := range strings.Split(normalize(content), "\n") {
		trimmed := strings.TrimLeft(line, " ")
		inFence := fence != ""
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			marker := trimmed[:1]
			n := len(trimmed) - len(strings.TrimLeft(trimmed, marker))
			if fence == "" {
				fence = strings.Repeat(marker, n)
			} else if strings.HasPrefix(trimmed, fence) && strings.TrimSpace(strings.TrimLeft(trimmed, marker)) == "" {
				fence = ""
			}
			inFence = true
		}
		if !inFence {
			match := anchorPattern.FindStringSubmatch(line)
			if match != nil {
				if !strings.Contains(" "+prefixes[chapter]+" ", " "+match[1]+" ") {
					return nil, &Error{"baseline_anchor_invalid"}
				}
				id := match[1] + "-" + match[2]
				if seen[id] {
					return nil, &Error{"baseline_anchor_duplicate"}
				}
				seen[id] = true
				sections = append(sections, Section{Anchor: id, Title: match[3]})
				bodies = append(bodies, new(strings.Builder))
				current = len(sections) - 1
				continue
			}
			if strings.HasPrefix(trimmed, "### [") {
				return nil, &Error{"baseline_anchor_invalid"}
			}
			if current > 0 && headingPattern.MatchString(line) {
				// Keep text outside anchor sections visible without extending a rule
				// past its H1-H3 boundary.
				if unanchored < 0 {
					sections = append(sections, Section{Anchor: "_unanchored"})
					bodies = append(bodies, new(strings.Builder))
					unanchored = len(sections) - 1
				}
				current = unanchored
			}
		}
		if current >= 0 {
			bodies[current].WriteString(line)
			bodies[current].WriteByte('\n')
		}
	}
	for i := range sections {
		sections[i].Body = normalize(bodies[i].String())
	}
	if sections[0].Body == "" {
		sections = sections[1:]
	}
	return sections, nil
}

func Compute(chapter, before, after string, baseNumber int32, exclusions, issuePrefix string) (Diff, error) {
	d := Diff{Chapter: chapter, BaseRevisionNumber: baseNumber, Added: []Change{}, Modified: []Change{}, Removed: []Change{}, Warnings: []Warning{}}
	old, err := Parse(chapter, before)
	if err != nil {
		return d, err
	}
	next, err := Parse(chapter, after)
	if err != nil {
		return d, err
	}
	deferred, err := Parse("exclusions_and_risks", exclusions)
	if err != nil {
		return d, err
	}
	oldMap, nextMap := map[string]Section{}, map[string]Section{}
	for _, s := range old {
		oldMap[s.Anchor] = s
	}
	for _, s := range next {
		nextMap[s.Anchor] = s
	}
	for _, s := range next {
		previous, exists := oldMap[s.Anchor]
		if !exists {
			d.Added = append(d.Added, Change{Anchor: s.Anchor, Title: s.Title, After: s.Body})
			continue
		}
		if previous.Title == s.Title && previous.Body == s.Body {
			d.UnchangedCount++
			continue
		}
		// Include titles in the compared text so title-only edits remain visible.
		oldText, newText := previous.Body, s.Body
		if previous.Title != s.Title {
			oldText = previous.Title + "\n" + oldText
			newText = s.Title + "\n" + newText
		}
		oldChars, newChars := utf8.RuneCountInString(previous.Body), utf8.RuneCountInString(s.Body)
		d.Modified = append(d.Modified, Change{Anchor: s.Anchor, Title: s.Title, Before: oldText, After: newText, BeforeChars: oldChars, AfterChars: newChars})
		if strings.HasPrefix(s.Anchor, "Rule-") && newChars*100 < oldChars*60 {
			d.Warnings = append(d.Warnings, Warning{"rule_shrunk", s.Anchor})
		}
	}
	for _, s := range old {
		if _, exists := nextMap[s.Anchor]; exists {
			continue
		}
		d.Removed = append(d.Removed, Change{Anchor: s.Anchor, Title: s.Title, Before: s.Body})
		if strings.HasPrefix(s.Anchor, "Rule-") {
			d.Warnings = append(d.Warnings, Warning{"rule_removed", s.Anchor})
		}
	}
	var deferredText strings.Builder
	for _, section := range deferred {
		if strings.HasPrefix(section.Anchor, "Defer-") {
			deferredText.WriteString(section.Title + "\n" + section.Body + "\n")
		}
	}
	references := deferredText.String()
	for _, w := range append([]Warning(nil), d.Warnings...) {
		if referencesRule(references, w.Anchor) {
			d.Warnings = append(d.Warnings, Warning{"rule_deferred", w.Anchor})
		}
	}

	if chapter == "exclusions_and_risks" {
		issuePattern := regexp.MustCompile(`\b` + regexp.QuoteMeta(issuePrefix) + `-[0-9]+\b`)
		for _, s := range next {
			text := s.Title + "\n" + s.Body
			if strings.HasPrefix(s.Anchor, "Defer-") && !issueLinkPattern.MatchString(text) && !(issuePrefix != "" && issuePattern.MatchString(text)) {
				d.Warnings = append(d.Warnings, Warning{"defer_missing_pool", s.Anchor})
			}
		}
	}
	return d, nil
}

func referencesRule(text, anchor string) bool {
	// Delimit the identifier: Rule-1 must not match Rule-10.
	return regexp.MustCompile(`(?:^|[^\pL\pN_-])` + regexp.QuoteMeta(anchor) + `(?:$|[^\pL\pN_-])`).MatchString(text)
}

func (d Diff) HasRuleCut() bool {
	for _, w := range d.Warnings {
		if w.Code == "rule_removed" || w.Code == "rule_shrunk" || w.Code == "rule_deferred" {
			return true
		}
	}
	return false
}
