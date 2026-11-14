package main

// Labrastro fork addition: uploaded attachment reference rewriting.
//
// Everything below was inlined in cmd_issue.go (upstream file) and is kept
// verbatim here so upstream edits to cmd_issue.go stay conflict-free.
// Call sites remain in cmd_issue.go; only this implementation moved.

import (
	"bytes"
	"html"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"

	"github.com/multica-ai/multica/server/internal/cli"
)

type uploadedIssueAttachment struct {
	localPath string
	response  cli.AttachmentResponse
}

type attachmentDestSpan struct {
	start int
	end   int
}

type attachmentSpanParser struct{ parser.InlineParser }

func (p attachmentSpanParser) Parse(parent ast.Node, reader text.Reader, pc parser.Context) ast.Node {
	beforeLine, before := reader.Position()
	n := p.InlineParser.Parse(parent, reader, pc)
	var dest []byte
	var hasRef bool
	switch node := n.(type) {
	case *ast.Link:
		dest = node.Destination
		hasRef = node.Reference != nil
	case *ast.Image:
		dest = node.Destination
		hasRef = node.Reference != nil
	default:
		return n
	}
	if !hasRef && len(dest) > 0 {
		endLine, end := reader.Position()
		reader.SetPosition(beforeLine, before)
		reader.Advance(1) // closing label bracket ']'
		if reader.Peek() == '(' {
			reader.Advance(1)
			reader.SkipSpaces()
			_, destStartPos := reader.Position()
			angleBracketed := false
			if reader.Peek() == '<' {
				angleBracketed = true
				reader.Advance(1)
			}
			_, rawDestPos := reader.Position()
			stop := rawDestPos.Start + len(dest)
			if rawDestPos.Start >= 0 && stop <= end.Start && bytes.HasPrefix(reader.Source()[rawDestPos.Start:], dest) {
				startOffset := rawDestPos.Start
				endOffset := stop
				if angleBracketed && stop < end.Start && reader.Source()[stop] == '>' {
					startOffset = destStartPos.Start
					endOffset = stop + 1
				}
				n.SetAttributeString("dest_span", attachmentDestSpan{start: startOffset, end: endOffset})
			}
		}
		reader.SetPosition(endLine, end)
	}
	return n
}

func (p attachmentSpanParser) CloseBlock(parent ast.Node, reader text.Reader, pc parser.Context) {
	if closer, ok := p.InlineParser.(parser.CloseBlocker); ok {
		closer.CloseBlock(parent, reader, pc)
	}
}

type attachmentSpanEdit struct {
	start       int
	end         int
	replacement string
}

var uriSchemePrefixRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)

func isMarkdownASCIIPunctuation(b byte) bool {
	switch b {
	case '!', '"', '#', '$', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/',
		':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~':
		return true
	default:
		return false
	}
}

func decodeMarkdownEscapes(raw string) string {
	if !strings.ContainsAny(raw, `\&`) {
		return raw
	}
	var out strings.Builder
	out.Grow(len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) && isMarkdownASCIIPunctuation(raw[i+1]) {
			out.WriteByte(raw[i+1])
			i++
			continue
		}
		if raw[i] == '&' {
			if semi := strings.IndexByte(raw[i:], ';'); semi > 1 && semi <= 32 {
				entity := raw[i : i+semi+1]
				if decoded := html.UnescapeString(entity); decoded != entity {
					out.WriteString(decoded)
					i += semi
					continue
				}
			}
		}
		out.WriteByte(raw[i])
	}
	return out.String()
}

func normalizeRelativeAttachmentTarget(raw string, markdownEscaped bool) (relPath string, baseName string, ok bool) {
	clean := strings.TrimSpace(raw)
	if clean == "" ||
		strings.HasPrefix(clean, "/") ||
		strings.HasPrefix(clean, `\`) ||
		filepath.IsAbs(clean) ||
		uriSchemePrefixRe.MatchString(clean) {
		return "", "", false
	}
	if markdownEscaped {
		clean = decodeMarkdownEscapes(clean)
		if strings.ContainsAny(clean, "?#") {
			return "", "", false
		}
		if unescaped, err := url.PathUnescape(clean); err == nil {
			clean = unescaped
		}
	} else if strings.ContainsAny(clean, "?#") {
		return "", "", false
	}
	clean = strings.ReplaceAll(clean, `\`, "/")
	for strings.HasPrefix(clean, "./") {
		clean = strings.TrimPrefix(clean, "./")
	}
	segments := strings.Split(clean, "/")
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." {
			return "", "", false
		}
	}
	return clean, segments[len(segments)-1], true
}

func matchUploadedAttachmentURL(destination string, uploaded []uploadedIssueAttachment) string {
	relPath, baseName, ok := normalizeRelativeAttachmentTarget(destination, true)
	if !ok {
		return ""
	}
	var exactMatch string
	exactCount := 0
	for _, u := range uploaded {
		if uRelPath, _, uOK := normalizeRelativeAttachmentTarget(u.localPath, false); uOK && uRelPath == relPath {
			exactMatch = u.response.MarkdownURL
			exactCount++
		}
	}
	if exactCount == 1 {
		return exactMatch
	}
	var baseMatch string
	baseCount := 0
	for _, u := range uploaded {
		if (u.localPath != "" && filepath.Base(u.localPath) == baseName) ||
			(u.response.Filename != "" && filepath.Base(u.response.Filename) == baseName) {
			baseMatch = u.response.MarkdownURL
			baseCount++
		}
	}
	if baseCount == 1 {
		return baseMatch
	}
	return ""
}

// resolveUploadedAttachmentReferences rewrites inline Markdown image, link, and
// `!file[label](dest)` destinations that name an uploaded `--attachment` by its
// relative path or filename into the uploaded attachment's durable `markdown_url`.
// Code spans and fenced code blocks are ignored via Goldmark's AST.
func resolveUploadedAttachmentReferences(body string, uploaded []uploadedIssueAttachment) string {
	if body == "" || len(uploaded) == 0 || !strings.Contains(body, "](") {
		return body
	}
	inlines := parser.DefaultInlineParsers()
	for i := range inlines {
		inlines[i].Value = attachmentSpanParser{inlines[i].Value.(parser.InlineParser)}
	}
	p := parser.NewParser(
		parser.WithBlockParsers(parser.DefaultBlockParsers()...),
		parser.WithInlineParsers(inlines...),
		parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
	)
	source := []byte(body)
	doc := p.Parse(text.NewReader(source))

	var edits []attachmentSpanEdit
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		spanVal, ok := n.AttributeString("dest_span")
		if !ok {
			return ast.WalkContinue, nil
		}
		var dest []byte
		switch node := n.(type) {
		case *ast.Image:
			dest = node.Destination
		case *ast.Link:
			dest = node.Destination
		}
		span := spanVal.(attachmentDestSpan)
		targetURL := matchUploadedAttachmentURL(string(dest), uploaded)
		if targetURL == "" || targetURL == string(dest) {
			return ast.WalkContinue, nil
		}
		edits = append(edits, attachmentSpanEdit{
			start:       span.start,
			end:         span.end,
			replacement: targetURL,
		})
		return ast.WalkContinue, nil
	})
	if len(edits) == 0 {
		return body
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start < edits[j].start })
	var out strings.Builder
	last := 0
	for _, edit := range edits {
		if edit.start < last {
			continue
		}
		out.WriteString(body[last:edit.start])
		out.WriteString(edit.replacement)
		last = edit.end
	}
	out.WriteString(body[last:])
	return out.String()
}
