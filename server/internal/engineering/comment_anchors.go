package engineering

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

var commentWikiLinks = regexp.MustCompile(`\[\[([^\]\r\n]+)\]\]`)

// Match ECMAScript whitespace so browser and server offsets agree, including NBSP.
func NormalizeCommentText(s string) string {
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return (r >= '\t' && r <= '\r') || r == ' ' || r == 0xa0 || r == 0x1680 ||
			(r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	}), " ")
}

type CommentSelector struct {
	Kind           string `json:"kind"`
	SectionAnchor  string `json:"section_anchor"`
	SectionTitle   string `json:"section_title"`
	Exact          string `json:"exact"`
	Prefix         string `json:"prefix"`
	Suffix         string `json:"suffix"`
	Start          *int   `json:"start,omitempty"`
	RevisionNumber int32  `json:"revision_number"`
}

type CommentSection struct {
	Heading
	Markdown string `json:"content_markdown"`
	Text     string `json:"text"`
}

// These slices include their own heading and stop at the next indexed heading.
// The preamble is addressable even on pages without headings.
func CommentSections(content string) []CommentSection {
	headings := scanHeadings(content)
	out := []CommentSection{}
	end := len(content)
	if len(headings) > 0 {
		end = headings[0].start
	}
	if strings.TrimSpace(content[:end]) != "" {
		out = append(out, CommentSection{Heading{"_preamble", "", 0}, content[:end], renderedCommentText(content[:end])})
	}
	for _, h := range headings {
		own := content[h.start:h.ownEnd]
		out = append(out, CommentSection{h.Heading, own, renderedCommentText(own)})
	}
	return out
}

type CommentLocation struct {
	State         string `json:"state"`
	SectionAnchor string `json:"section_anchor,omitempty"`
	Start         *int   `json:"start,omitempty"`
}

func utf16Length(s string) int { return len(utf16.Encode([]rune(s))) }

func quoteOffsets(text, exact string) []int {
	out := []int{}
	if exact == "" {
		return out
	}
	for offset := 0; offset <= len(text); {
		n := strings.Index(text[offset:], exact)
		if n < 0 {
			break
		}
		n += offset
		out = append(out, n)
		offset = n + 1
	}
	return out
}

// Prefix/suffix score wins before distance; a final tie keeps the earlier match.
func LocateCommentQuote(text string, a CommentSelector) *int {
	best, score, distance := -1, -1, int(^uint(0)>>1)
	hint := 0
	if a.Start != nil {
		hint = *a.Start
	}
	for _, pos := range quoteOffsets(text, a.Exact) {
		rank := 0
		if a.Prefix != "" && strings.HasSuffix(text[:pos], a.Prefix) {
			rank++
		}
		if a.Suffix != "" && strings.HasPrefix(text[pos+len(a.Exact):], a.Suffix) {
			rank++
		}
		start := utf16Length(text[:pos])
		delta := start - hint
		if delta < 0 {
			delta = -delta
		}
		if rank > score || (rank == score && delta < distance) {
			best, score, distance = start, rank, delta
		}
	}
	if best < 0 {
		return nil
	}
	return &best
}

func LocateComment(sections []CommentSection, a CommentSelector) CommentLocation {
	original := -1
	for i, s := range sections {
		if s.Anchor == a.SectionAnchor {
			original = i
			break
		}
	}
	if original >= 0 {
		if a.Kind == "section" {
			return CommentLocation{State: "anchored", SectionAnchor: a.SectionAnchor}
		}
		if start := LocateCommentQuote(sections[original].Text, a); start != nil {
			return CommentLocation{"anchored", a.SectionAnchor, start}
		}
	}
	matches := []CommentLocation{}
	for _, s := range sections {
		if a.Kind == "section" {
			if a.SectionTitle != "" && s.Title == a.SectionTitle {
				matches = append(matches, CommentLocation{State: "moved", SectionAnchor: s.Anchor})
			}
		} else {
			// A page-wide move requires a unique occurrence, not merely a unique section.
			for _, pos := range quoteOffsets(s.Text, a.Exact) {
				start := utf16Length(s.Text[:pos])
				matches = append(matches, CommentLocation{"moved", s.Anchor, &start})
			}
		}
	}
	if len(matches) == 1 {
		return matches[0]
	}
	if original >= 0 {
		return CommentLocation{State: "section_only", SectionAnchor: a.SectionAnchor}
	}
	return CommentLocation{State: "orphaned"}
}

// CompleteCommentQuote is the CLI's strict, unique locator. Browser selectors
// can disambiguate repeated text; the CLI intentionally never guesses.
func CompleteCommentQuote(sections []CommentSection, section, quote string, revision int32) (CommentSelector, error) {
	candidates := []CommentSection{}
	for _, s := range sections {
		if section == "" || section == s.Anchor {
			candidates = append(candidates, s)
		}
	}
	if section != "" && len(candidates) == 0 {
		for _, s := range sections {
			if s.Title == section {
				candidates = append(candidates, s)
			}
		}
	}
	if section != "" && len(candidates) == 0 {
		return CommentSelector{}, &Error{"baseline_section_not_found"}
	}
	if section != "" && len(candidates) > 1 {
		return CommentSelector{}, &Error{"baseline_section_ambiguous"}
	}
	quote = NormalizeCommentText(quote)
	result := CommentSelector{Kind: "section", RevisionNumber: revision}
	count := 0
	for _, s := range candidates {
		if quote == "" {
			result.SectionAnchor, result.SectionTitle = s.Anchor, s.Title
			count++
			continue
		}
		for _, pos := range quoteOffsets(s.Text, quote) {
			prefix, suffix := []rune(s.Text[:pos]), []rune(s.Text[pos+len(quote):])
			if len(prefix) > 64 {
				prefix = prefix[len(prefix)-64:]
			}
			if len(suffix) > 64 {
				suffix = suffix[:64]
			}
			start := utf16Length(s.Text[:pos])
			result = CommentSelector{"text", s.Anchor, s.Title, quote, string(prefix), string(suffix), &start, revision}
			count++
		}
	}
	if count == 0 {
		return CommentSelector{}, &Error{"baseline_quote_not_found"}
	}
	if count != 1 {
		return CommentSelector{}, &Error{"baseline_quote_ambiguous"}
	}
	return result, nil
}
