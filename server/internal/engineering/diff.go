// Package engineering computes deterministic baseline diffs without model calls.
package engineering

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

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
	BaseRevisionNumber int32     `json:"base_revision_number"`
	Added              []Change  `json:"added"`
	Modified           []Change  `json:"modified"`
	Removed            []Change  `json:"removed"`
	UnchangedCount     int       `json:"unchanged_count"`
	Warnings           []Warning `json:"warnings"`
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

// validate holds Parse's input checks for callers that never use the sections.
func validate(content string) error {
	if len(content) > 65536 {
		return &Error{"baseline_too_large"}
	}
	if !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return &Error{"baseline_content_invalid"}
	}
	return nil
}

// Parse ignores fenced examples and ends each anchor at the next H1-H3 heading.
func Parse(content string) ([]Section, error) {
	if err := validate(content); err != nil {
		return nil, err
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

func Compute(before, after string, baseNumber int32) (Diff, error) {
	d := Diff{BaseRevisionNumber: baseNumber, Added: []Change{}, Modified: []Change{}, Removed: []Change{}, Warnings: []Warning{}}
	old, err := Parse(before)
	if err != nil {
		return d, err
	}
	next, err := Parse(after)
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

// ValidateContent applies Parse's input checks for callers that never need
// the sections.
func ValidateContent(content string) error { return validate(content) }
