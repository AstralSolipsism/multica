package util

import (
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// MarkdownSourceParser records complete inline source boundaries while the
// parser owns the reader. Link/image ends cannot be recovered from their AST
// children: destinations, titles and reference labels are no longer text nodes.
type MarkdownSourceParser struct{ parser.InlineParser }

func (p MarkdownSourceParser) Parse(parent ast.Node, reader text.Reader, pc parser.Context) ast.Node {
	_, before := reader.Position()
	n := p.InlineParser.Parse(parent, reader, pc)
	switch n.(type) {
	case *ast.Link, *ast.Image, *ast.CodeSpan, *ast.AutoLink, *ast.RawHTML:
		_, end := reader.Position()
		start := before.Start
		switch n.(type) {
		case *ast.Link, *ast.Image:
			start = n.Pos()
		}
		n.SetAttributeString("source_start", start)
		n.SetAttributeString("source_end", end.Start)
	}
	return n
}

func (p MarkdownSourceParser) CloseBlock(parent ast.Node, reader text.Reader, pc parser.Context) {
	if closer, ok := p.InlineParser.(parser.CloseBlocker); ok {
		closer.CloseBlock(parent, reader, pc)
	}
}
