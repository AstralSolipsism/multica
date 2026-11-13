package engineering

import (
	"bytes"
	"strconv"
	"strings"

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
