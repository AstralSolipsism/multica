package engineering

import (
	"bytes"
	"strconv"
	"strings"

	"github.com/yuin/goldmark"
	xhtml "golang.org/x/net/html"
)

// AnnotationSection uses exact index anchors and preserves source whitespace.
// OwnMarkdown excludes descendants; ContentMarkdown includes the subtree.
type AnnotationSection struct {
	SectionSlice
	OwnMarkdown string
}

func FindAnnotationSection(chapter, content, anchor string) (AnnotationSection, bool) {
	if _, err := Parse(chapter, content); err != nil {
		return AnnotationSection{}, false
	}
	for _, h := range scanHeadings(content) {
		if h.Anchor == anchor {
			return AnnotationSection{SectionSlice{chapter, h.Heading, content[h.start:h.end]}, content[h.start:h.ownEnd]}, true
		}
	}
	return AnnotationSection{}, false
}

// A selected ancestor already carries the full descendant subtree.
func AnnotationSubtrees(chapter, content string, anchors map[string]bool) []SectionSlice {
	out := []SectionSlice{}
	end := -1
	for _, h := range scanHeadings(content) {
		if anchors[h.Anchor] && h.start >= end {
			out = append(out, SectionSlice{chapter, h.Heading, content[h.start:h.end]})
			end = h.end
		}
	}
	return out
}

func SourceLines(source string) []string {
	source = strings.ReplaceAll(strings.ReplaceAll(source, "\r\n", "\n"), "\r", "\n")
	return strings.Split(strings.TrimSuffix(source, "\n"), "\n")
}

type AnnotationAnchor struct {
	Kind, Section, Quote, Prefix, Suffix string
	Start, LineStart, LineEnd            int
}

type AnnotationLocation struct {
	RevisionNumber int32 `json:"revision_number"`
	LineStart      *int  `json:"line_start,omitempty"`
	LineEnd        *int  `json:"line_end,omitempty"`
	Start          *int  `json:"start,omitempty"`
}

func uniqueQuote(text, quote, prefix, suffix string) int {
	if quote == "" {
		return -1
	}
	found := -1
	for offset := 0; offset <= len(text); {
		n := strings.Index(text[offset:], quote)
		if n < 0 {
			break
		}
		n += offset
		if strings.HasSuffix(text[:n], prefix) && strings.HasPrefix(text[n+len(quote):], suffix) {
			if found >= 0 {
				return -1
			}
			found = n
		}
		offset = n + 1
	}
	return found
}

// Text selections use normalized rendered text, never Markdown syntax.
func renderedAnnotationText(source string) string {
	var rendered bytes.Buffer
	if goldmark.Convert([]byte(source), &rendered) != nil {
		return ""
	}
	z := xhtml.NewTokenizer(&rendered)
	var text strings.Builder
	for {
		switch z.Next() {
		case xhtml.ErrorToken:
			return strings.Join(strings.Fields(text.String()), " ")
		case xhtml.TextToken:
			text.Write(z.Text())
		case xhtml.StartTagToken, xhtml.EndTagToken, xhtml.SelfClosingTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "p", "br", "li", "h1", "h2", "h3", "pre", "tr", "div":
				text.WriteByte(' ')
			}
		}
	}
}

func LocateAnnotation(chapter, working string, revision int32, sameRevision bool, a AnnotationAnchor) (string, *AnnotationLocation) {
	s, ok := FindAnnotationSection(chapter, working, a.Section)
	if !ok {
		return "outdated", nil
	}
	located := &AnnotationLocation{RevisionNumber: revision}
	if a.Kind == "section" {
		return "exact", located
	}
	if sameRevision {
		if a.Kind == "lines" {
			located.LineStart, located.LineEnd = &a.LineStart, &a.LineEnd
		} else {
			located.Start = &a.Start
		}
		return "exact", located
	}
	if a.Kind == "lines" {
		text := strings.Join(SourceLines(s.OwnMarkdown), "\n")
		quote := strings.ReplaceAll(strings.ReplaceAll(a.Quote, "\r\n", "\n"), "\r", "\n")
		pos := uniqueQuote(text, quote, "", "")
		if pos < 0 {
			return "outdated", nil
		}
		start := strings.Count(text[:pos], "\n") + 1
		end := start + strings.Count(strings.TrimSuffix(quote, "\n"), "\n")
		located.LineStart, located.LineEnd = &start, &end
		return "moved", located
	}
	text := renderedAnnotationText(s.OwnMarkdown)
	pos := uniqueQuote(text, a.Quote, a.Prefix, a.Suffix)
	if pos < 0 {
		return "section_only", located
	}
	// Browser selection offsets count UTF-16 code units.
	start := 0
	for _, r := range text[:pos] {
		start++
		if r > 0xffff {
			start++
		}
	}
	located.Start = &start
	return "moved", located
}

// User-controlled summary and anchors must remain inert even in code fences:
// the platform scans raw text for mention links before rendering Markdown.
func AnnotationTicketText(value string) string {
	var out strings.Builder
	for _, r := range strings.ReplaceAll(strings.Join(strings.Fields(value), " "), "&", "&amp;") {
		if strings.ContainsRune("<>\\`*_[]{}()#!|~:$+.=-", r) {
			out.WriteString("&#" + strconv.Itoa(int(r)) + ";")
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}
