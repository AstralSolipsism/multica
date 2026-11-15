package engineering

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	xhtml "golang.org/x/net/html"
)

// Text selections use normalized rendered text, never Markdown syntax.
func renderedCommentText(source string) string {
	var rendered bytes.Buffer
	if goldmark.New(goldmark.WithExtensions(extension.GFM)).Convert([]byte(source), &rendered) != nil {
		return ""
	}
	z := xhtml.NewTokenizer(&rendered)
	var text strings.Builder
	codeDepth := 0
	for {
		switch z.Next() {
		case xhtml.ErrorToken:
			return NormalizeCommentText(text.String())
		case xhtml.TextToken:
			value := string(z.Text())
			if codeDepth == 0 {
				value = repairCjkStrong(value)
				value = repairHighlightMarkers(value)
				value = commentWikiLinks.ReplaceAllStringFunc(value, func(raw string) string {
					_, section, display := ParseWikiLinkRaw(raw[2 : len(raw)-2])
					if section != "" {
						display += " › " + section
					}
					return display
				})
			}
			text.WriteString(value)
		case xhtml.StartTagToken, xhtml.EndTagToken, xhtml.SelfClosingTagToken:
			name, _ := z.TagName()
			if string(name) == "code" {
				if z.Token().Type == xhtml.EndTagToken {
					codeDepth--
				} else {
					codeDepth++
				}
			}
			switch string(name) {
			case "p", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "tr", "td", "th", "blockquote", "div", "ul", "ol", "table", "hr":
				text.WriteByte(' ')
			}
		}
	}
}

// cjkRune reports whether r is a CJK script LETTER (Han, Hiragana, Katakana,
// Hangul). CJK punctuation such as 「」。， is Script=Common and must NOT match:
// the letter/punctuation asymmetry is exactly what breaks CommonMark emphasis
// around CJK prose.
func cjkRune(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
}

func nonSpace(s string) bool {
	for _, r := range s {
		if !unicode.IsSpace(r) {
			return true
		}
	}
	return false
}

func containsCJK(s string) bool {
	for _, r := range s {
		if cjkRune(r) {
			return true
		}
	}
	return false
}

// cjkStrongCandidate mirrors repairSpan in packages/views/rich-content/cjk-emphasis.ts:
// a literal `**inner**` inside ONE text run that CommonMark left unrepaired.
//
//	(a1) `**中文。 **` — trailing whitespace inside: a closer preceded by
//	     whitespace can never close, whatever follows the span.
//	(a2) `** 中文。**` — leading whitespace inside (the opener can never open).
//	(b1) `采用**「…」**的` — a CJK letter glued before the opener.
//	(b2) `**加粗**的` — a CJK letter glued after the closer.
//
// Text-wise every rule is equivalent to deleting the two `**` runs, which is
// what the web renderer produces through its remark repair plugin; keep the
// two predicate sets in sync so anchors.json stays green on both sides.
func cjkStrongCandidate(value string, opening, closing int) bool {
	inner := value[opening+2 : closing]
	if inner == "" || strings.Contains(inner, "**") {
		return false
	}
	first, _ := utf8.DecodeRuneInString(inner)
	last, _ := utf8.DecodeLastRuneInString(inner)
	var before, after rune = -1, -1
	if opening > 0 {
		before, _ = utf8.DecodeLastRuneInString(value[:opening])
	}
	if closing+2 < len(value) {
		after, _ = utf8.DecodeRuneInString(value[closing+2:])
	}
	cjkInside := containsCJK(inner) && nonSpace(inner)
	switch {
	case cjkInside && first != ' ' && first != '\t' && (last == ' ' || last == '\t'):
		return true
	case cjkInside && (first == ' ' || first == '\t') && last != ' ' && last != '\t':
		return true
	case before != -1 && cjkRune(before) && nonSpace(inner):
		return true
	case after != -1 && cjkRune(after) && nonSpace(inner):
		return true
	}
	return false
}

// repairCjkStrong deletes the `**` delimiters of every broken CJK emphasis
// span in one text run, leaving the inner text verbatim.
func repairCjkStrong(value string) string {
	if !strings.Contains(value, "**") {
		return value
	}
	var out strings.Builder
	consumed, cursor := 0, 0
	for cursor < len(value)-1 {
		opening := strings.Index(value[cursor:], "**")
		if opening == -1 {
			break
		}
		opening += cursor
		if opening+2 >= len(value) {
			break
		}
		first, _ := utf8.DecodeRuneInString(value[opening+2:])
		if first == '*' {
			cursor = opening + 2
			continue
		}
		rel := strings.Index(value[opening+2:], "**")
		if rel == -1 {
			break
		}
		closing := opening + 2 + rel
		if !cjkStrongCandidate(value, opening, closing) {
			cursor = opening + 2
			continue
		}
		out.WriteString(value[consumed:opening])
		out.WriteString(value[opening+2 : closing])
		consumed = closing + 2
		cursor = consumed
	}
	if consumed == 0 {
		return value
	}
	out.WriteString(value[consumed:])
	return out.String()
}

// highlightMarker matches the `==text==` highlight syntax the web read-only
// pipeline lowers to <mark> before rendering (highlightToHtml). goldmark has
// no such extension, so those spans stay literal here; text-wise the lowering
// is deleting the two `==` runs.
var highlightMarker = regexp.MustCompile(`==([^=\n]+)==`)

// repairHighlightMarkers keeps the server text index in step with that
// lowering. Single-line pairs only, mirroring highlight-match.ts's rule that
// a highlight may not cross a line break.
func repairHighlightMarkers(value string) string {
	if !strings.Contains(value, "==") {
		return value
	}
	return highlightMarker.ReplaceAllString(value, "$1")
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
