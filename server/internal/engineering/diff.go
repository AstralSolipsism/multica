// Package engineering computes deterministic baseline diffs without model calls.
package engineering

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var Chapters = []string{"overview", "domain_rules", "architecture", "exclusions_and_risks"}

var headingPattern = regexp.MustCompile(`^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$`)
var explicitKeyPattern = regexp.MustCompile(`^\[([\pL\pN_]+-[^\]\r\n]{1,64})\][ \t]*(.*)$`)

type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }

type Section struct {
	Anchor string
	Title  string
	Body   string
}

type Change struct {
	Anchor string `json:"anchor"`
	Title  string `json:"title"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
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

var moduleChapterPattern = regexp.MustCompile(`^module:[a-z0-9][a-z0-9_-]{0,62}$`)

func ValidChapter(chapter string) bool {
	return slices.Contains(Chapters, chapter) || moduleChapterPattern.MatchString(chapter)
}

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
		return nil, &Error{"invalid_request"}
	}
	if len(content) > 65536 {
		return nil, &Error{"baseline_too_large"}
	}
	if !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return nil, &Error{"baseline_content_invalid"}
	}
	headings := scanHeadings(content)
	sections := []Section{}
	preambleEnd := len(content)
	if len(headings) > 0 {
		preambleEnd = headings[0].start
	}
	if body := normalize(content[:preambleEnd]); body != "" {
		sections = append(sections, Section{Anchor: "_preamble", Body: body})
	}
	for _, h := range headings {
		sections = append(sections, Section{Anchor: h.Anchor, Title: h.Title, Body: normalize(content[h.bodyStart:h.ownEnd])})
	}
	return sections, nil
}

func Compute(chapter, before, after string, baseNumber int32) (Diff, error) {
	d := Diff{Chapter: chapter, BaseRevisionNumber: baseNumber, Added: []Change{}, Modified: []Change{}, Removed: []Change{}, Warnings: []Warning{}}
	old, err := Parse(chapter, before)
	if err != nil {
		return d, err
	}
	next, err := Parse(chapter, after)
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
		d.Modified = append(d.Modified, Change{Anchor: s.Anchor, Title: s.Title, Before: oldText, After: newText})
	}
	for _, s := range old {
		if _, exists := nextMap[s.Anchor]; exists {
			continue
		}
		d.Removed = append(d.Removed, Change{Anchor: s.Anchor, Title: s.Title, Before: s.Body})
	}
	return d, nil
}
