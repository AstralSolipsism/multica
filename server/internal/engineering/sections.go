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
		// Cheap prefilter for headingPattern's `^ {0,3}#`: most lines are body text.
		if !inFence && len(line)-len(trimmed) <= 3 && strings.HasPrefix(trimmed, "#") {
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

func Index(content string) ([]Heading, error) {
	if err := validate(content); err != nil {
		return nil, err
	}
	out := []Heading{}
	for _, h := range scanHeadings(content) {
		out = append(out, h.Heading)
	}
	return out, nil
}

func exactMatchingHeadings(headings []documentHeading, query string) []int {
	exact := []int{}
	for i, h := range headings {
		if h.Anchor == query || h.Title == query {
			exact = append(exact, i)
		}
	}
	return exact
}

// Reads prefer exact matches across the entire scope, then case-insensitive substrings.
func matchingHeadings(headings []documentHeading, query string) []int {
	query = strings.TrimSpace(query)
	if exact := exactMatchingHeadings(headings, query); len(exact) > 0 {
		return exact
	}
	partial := []int{}
	query = strings.ToLower(query)
	for i, h := range headings {
		if strings.Contains(strings.ToLower(h.Anchor), query) || strings.Contains(strings.ToLower(h.Title), query) {
			partial = append(partial, i)
		}
	}
	return partial
}

func MergeSection(before, query, replacement string, deleting bool) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" || strings.ContainsAny(query, "\r\n\x00") || deleting && replacement != "" {
		return "", &Error{"invalid_request"}
	}
	if err := validate(before); err != nil {
		return "", err
	}
	if err := validate(replacement); err != nil {
		return "", err
	}
	headings := scanHeadings(before)
	matches := exactMatchingHeadings(headings, query)
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
	if err := validate(merged); err != nil {
		return "", err
	}
	return merged, nil
}

type PageContent struct {
	Slug    string
	Content string
}

type SectionSlice struct {
	Page string `json:"page"`
	Heading
	ContentMarkdown string `json:"content_markdown"`
}

type ReferencedSection struct {
	Page string `json:"page"`
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

func ReadSections(pages []PageContent, page, query string) (Slice, error) {
	out := Slice{Sections: []SectionSlice{}, ReferencedSections: []ReferencedSection{}}
	if strings.TrimSpace(query) == "" {
		return out, &Error{"invalid_request"}
	}
	type located struct {
		page, content string
		documentHeading
	}
	all, scope := []located{}, []documentHeading{}
	scopeIDs := []int{}
	for _, c := range pages {
		if err := validate(c.Content); err != nil {
			return out, err
		}
		for _, h := range scanHeadings(c.Content) {
			all = append(all, located{c.Slug, c.Content, h})
			if page == "" || page == c.Slug {
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
		out.Sections = append(out.Sections, SectionSlice{s.page, s.Heading, s.content[s.start:s.end]})
		bodies = append(bodies, s.content[s.bodyStart:s.end])
		for j, other := range all {
			if other.page == s.page && other.start >= s.start && other.start < s.end {
				selected[j] = true
			}
		}
	}
	body := strings.Join(bodies, "\n")
	lowerBody := strings.ToLower(body)
	refs := map[string]bool{}
	for _, m := range wikiReferencePattern.FindAllStringSubmatch(body, -1) {
		refs[strings.ToLower(strings.TrimSpace(m[1]))] = true
	}
	for i, s := range all {
		if selected[i] {
			continue
		}
		if refs[strings.ToLower(s.Anchor)] || refs[strings.ToLower(s.Title)] || s.Title != "" && strings.Contains(lowerBody, strings.ToLower(s.Title)) {
			out.ReferencedSections = append(out.ReferencedSections, ReferencedSection{s.page, s.Heading, paragraph(s.content[s.bodyStart:s.ownEnd]), sectionWhy(s.content[s.bodyStart:s.end])})
		}
	}
	return out, nil
}

// SectionSubtree returns a section's markdown including descendants; section
// writes compare it byte-for-byte when deciding orthogonal auto-rebase.
func SectionSubtree(content, query string) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", &Error{"invalid_request"}
	}
	if err := validate(content); err != nil {
		return "", err
	}
	matches := exactMatchingHeadings(scanHeadings(content), query)
	if len(matches) > 1 {
		return "", &Error{"baseline_section_ambiguous"}
	}
	if len(matches) == 0 {
		return "", &Error{"baseline_section_not_found"}
	}
	h := scanHeadings(content)[matches[0]]
	return content[h.start:h.end], nil
}
