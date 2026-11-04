package engineering

import (
	"regexp"
	"strconv"
	"strings"
)

type Heading struct {
	Anchor string `json:"anchor"`
	Title  string `json:"title"`
	Level  int    `json:"level"`
}

type documentHeading struct {
	Heading
	start, bodyStart, ownEnd, end int
	line                          string
}

// The Diff, index and edits share anchors. Offsets refer to the original bytes
// so a local edit leaves unrelated whitespace and line endings untouched.
func scanHeadings(content string) []documentHeading {
	headings := []documentHeading{}
	seen := map[string]bool{}
	parent, fence := "", ""
	for start := 0; start < len(content); {
		end := len(content)
		if n := strings.IndexAny(content[start:], "\r\n"); n >= 0 {
			end = start + n
		}
		next := end
		if next < len(content) {
			next++
			if content[end] == '\r' && next < len(content) && content[next] == '\n' {
				next++
			}
		}
		line := content[start:end]
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
			if match := headingPattern.FindStringSubmatch(strings.TrimRight(line, " \t")); match != nil {
				if len(headings) == 0 && normalize(content[:start]) != "" {
					seen["_preamble"] = true
				}
				title := strings.Join(strings.Fields(match[2]), " ")
				key := title
				if explicit := explicitKeyPattern.FindStringSubmatch(strings.TrimSpace(match[2])); explicit != nil {
					key, title = explicit[1], explicit[2]
				} else if len(match[1]) == 3 && parent != "" {
					key = parent + " / " + key
				}
				base := key
				for n := 2; seen[key]; n++ {
					key = base + " (" + strconv.Itoa(n) + ")"
				}
				seen[key] = true
				if len(match[1]) < 3 {
					parent = key
				}
				headings = append(headings, documentHeading{Heading: Heading{key, title, len(match[1])}, start: start, bodyStart: next, ownEnd: len(content), end: len(content), line: line})
			}
		}
		start = next
	}
	for i := range headings {
		if i+1 < len(headings) {
			headings[i].ownEnd = headings[i+1].start
		}
		for j := i + 1; j < len(headings); j++ {
			if headings[j].Level <= headings[i].Level {
				headings[i].end = headings[j].start
				break
			}
		}
	}
	return headings
}

func Index(chapter, content string) ([]Heading, error) {
	if _, err := Parse(chapter, content); err != nil {
		return nil, err
	}
	out := []Heading{}
	for _, h := range scanHeadings(content) {
		out = append(out, h.Heading)
	}
	return out, nil
}

// Exact matches across the entire scope win over case-insensitive substrings.
func matchingHeadings(headings []documentHeading, query string) []int {
	exact, partial := []int{}, []int{}
	query = strings.TrimSpace(query)
	for i, h := range headings {
		if h.Anchor == query || h.Title == query {
			exact = append(exact, i)
		}
		if strings.Contains(strings.ToLower(h.Anchor), strings.ToLower(query)) || strings.Contains(strings.ToLower(h.Title), strings.ToLower(query)) {
			partial = append(partial, i)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	return partial
}

func MergeSection(chapter, before, query, replacement string, deleting bool) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" || strings.ContainsAny(query, "\r\n\x00") || deleting && replacement != "" {
		return "", &Error{"invalid_request"}
	}
	if _, err := Parse(chapter, before); err != nil {
		return "", err
	}
	if _, err := Parse(chapter, replacement); err != nil {
		return "", err
	}
	headings := scanHeadings(before)
	matches := matchingHeadings(headings, query)
	if len(matches) > 1 {
		return "", &Error{"baseline_section_ambiguous"}
	}
	if deleting && len(matches) == 0 {
		return "", &Error{"baseline_section_not_found"}
	}
	start, end, level, heading := len(before), len(before), 2, "## "+query
	if len(matches) == 1 {
		h := headings[matches[0]]
		start, end, level, heading = h.start, h.end, h.Level, h.line
	}
	if !deleting {
		replacement = strings.TrimSpace(replacement)
		first, _, _ := strings.Cut(replacement, "\n")
		if headingPattern.FindStringSubmatch(strings.TrimSuffix(first, "\r")) == nil {
			replacement = heading + "\n" + replacement
		}
		inserted := scanHeadings(replacement)
		if len(matches) == 0 && len(inserted) > 0 {
			level = inserted[0].Level
		}
		// A local edit may contain descendants, but cannot introduce siblings or
		// change its root depth and silently absorb an untouched neighboring section.
		for i, h := range inserted {
			if i == 0 && h.Level != level || i > 0 && h.Level <= level {
				return "", &Error{"invalid_request"}
			}
		}
		if start == len(before) && before != "" && !strings.HasSuffix(before, "\n") {
			replacement = "\n" + replacement
		}
		replacement += "\n\n"
	}
	merged := before[:start] + replacement + before[end:]
	if _, err := Parse(chapter, merged); err != nil {
		return "", err
	}
	return merged, nil
}

type ChapterContent struct {
	Chapter string
	Content string
}

type SectionSlice struct {
	Chapter string `json:"chapter"`
	Heading
	ContentMarkdown string `json:"content_markdown"`
}

type ReferencedSection struct {
	Chapter string `json:"chapter"`
	Heading
	Definition string `json:"definition"`
	Why        string `json:"why"`
}

type Slice struct {
	Sections           []SectionSlice      `json:"sections"`
	ReferencedSections []ReferencedSection `json:"referenced_sections"`
}

var wikiReferencePattern = regexp.MustCompile(`\[\[([^\]\r\n]+)\]\]`)
var whyPattern = regexp.MustCompile(`(?i)^(?:#{1,6}[ \t]+)?(?:[-*][ \t]+)?(?:\*\*)?(?:为什么这样规定|为什么|原因|理由|why|rationale)(?:\*\*)?(?:[ \t]*[：:][ \t]*(?:\*\*)?[ \t]*|[ \t]+|$)(.*)$`)

func paragraph(body string) string {
	return strings.SplitN(strings.TrimSpace(normalize(body)), "\n\n", 2)[0]
}

func sectionWhy(body string) string {
	lines := strings.Split(normalize(body), "\n")
	for i, line := range lines {
		if m := whyPattern.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			return paragraph(m[1] + "\n" + strings.Join(lines[i+1:], "\n"))
		}
	}
	return ""
}

func ReadSections(chapters []ChapterContent, chapter, query string) (Slice, error) {
	out := Slice{Sections: []SectionSlice{}, ReferencedSections: []ReferencedSection{}}
	if strings.TrimSpace(query) == "" {
		return out, &Error{"invalid_request"}
	}
	type located struct {
		chapter, content string
		documentHeading
	}
	all, scope := []located{}, []documentHeading{}
	scopeIDs := []int{}
	for _, c := range chapters {
		if _, err := Parse(c.Chapter, c.Content); err != nil {
			return out, err
		}
		for _, h := range scanHeadings(c.Content) {
			all = append(all, located{c.Chapter, c.Content, h})
			if chapter == "" || chapter == c.Chapter {
				scope = append(scope, h)
				scopeIDs = append(scopeIDs, len(all)-1)
			}
		}
	}
	matches := matchingHeadings(scope, query)
	if len(matches) == 0 {
		return out, &Error{"baseline_section_not_found"}
	}
	selected := map[int]bool{}
	var bodies []string
	for _, match := range matches {
		i := scopeIDs[match]
		s := all[i]
		out.Sections = append(out.Sections, SectionSlice{s.chapter, s.Heading, s.content[s.start:s.end]})
		bodies = append(bodies, s.content[s.bodyStart:s.end])
		for j, other := range all {
			if other.chapter == s.chapter && other.start >= s.start && other.start < s.end {
				selected[j] = true
			}
		}
	}
	body := strings.Join(bodies, "\n")
	refs := map[string]bool{}
	for _, m := range wikiReferencePattern.FindAllStringSubmatch(body, -1) {
		refs[strings.ToLower(strings.TrimSpace(m[1]))] = true
	}
	for i, s := range all {
		if selected[i] {
			continue
		}
		if refs[strings.ToLower(s.Anchor)] || refs[strings.ToLower(s.Title)] || s.Title != "" && strings.Contains(strings.ToLower(body), strings.ToLower(s.Title)) {
			out.ReferencedSections = append(out.ReferencedSections, ReferencedSection{s.chapter, s.Heading, paragraph(s.content[s.bodyStart:s.ownEnd]), sectionWhy(s.content[s.bodyStart:s.end])})
		}
	}
	return out, nil
}
