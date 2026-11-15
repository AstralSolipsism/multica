package engineering

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	internalutil "github.com/multica-ai/multica/server/internal/util"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type commentLiteral struct {
	start, end int
}

// Highlight exclusion is deliberately broader than valid math (findCodeRanges).
var commentMathLiteral = regexp.MustCompile(`(?s)\$\$.*?\$\$|\$[^$\r\n]+\$`)
var commentBlankLine = regexp.MustCompile(`\r?\n[ \t]*\r?\n`)

// The source-level highlight rules mirror editor/utils/highlight-match.ts:
// no inner edge whitespace, no blank lines, and no delimiters inside literals.
// Math is indexed as authored source, atomically, just like data-math-source.
func commentMarkdown(source string) string {
	if !strings.Contains(source, "==") && !strings.Contains(source, "$") {
		return source
	}
	literals, excluded := commentSourceRanges(source)
	for _, match := range commentMathLiteral.FindAllStringIndex(source, -1) {
		start, end := match[0], match[1]
		if !strings.HasPrefix(source[start:], "$$") && (start > 0 && source[start-1] == '$' || end < len(source) && source[end] == '$') {
			continue
		}
		blocked := false
		for _, span := range literals {
			if start < span.end && end > span.start {
				blocked = true
				break
			}
		}
		if !blocked {
			literals = append(literals, commentLiteral{start, end})
		}
	}
	inside := func(pos int) bool {
		for _, span := range literals {
			if pos >= span.start && pos < span.end {
				return true
			}
		}
		return false
	}
	edges := map[int]string{}
	for i := 0; i+2 < len(source); i++ {
		if source[i:i+2] != "==" || inside(i) {
			continue
		}
		first, _ := utf8.DecodeRuneInString(source[i+2:])
		if unicode.IsSpace(first) {
			i++
			continue
		}
		limit := len(source) - 1
		if blank := commentBlankLine.FindStringIndex(source[i+2:]); blank != nil {
			limit = i + 2 + blank[0]
		}
		for j := i + 3; j <= limit && j+1 < len(source); j++ {
			last, _ := utf8.DecodeLastRuneInString(source[:j])
			if source[j:j+2] == "==" && !inside(j) && !unicode.IsSpace(last) {
				edges[i], edges[j] = "<mark>", "</mark>"
				i = j
				break
			}
		}
		i++
	}
	maths := map[int]int{}
	for _, span := range commentMathRanges(source, excluded) {
		maths[span.start] = span.end
	}
	var out strings.Builder
	for i := 0; i < len(source); {
		if end, ok := maths[i]; ok {
			// Numeric entities preserve TeX punctuation through CommonMark without
			// introducing raw HTML or letting escapes/emphasis alter the formula.
			for _, r := range source[i:end] {
				out.WriteString("&#" + strconv.Itoa(int(r)) + ";")
			}
			i = end
		} else if tag, ok := edges[i]; ok {
			out.WriteString(tag)
			i += 2
		} else {
			out.WriteByte(source[i])
			i++
		}
	}
	return out.String()
}

// Goldmark supplies the same isolated constructs as remarkSingleDollarMath.
// Keep these separate from highlight literals: link labels may be highlighted,
// and rejected dollar candidates still protect their internal == delimiters.
func commentSourceRanges(source string) (literals, excluded []commentLiteral) {
	inlines := parser.DefaultInlineParsers()
	inlines = append(inlines, util.Prioritized(extension.NewLinkifyParser(), 999))
	for i := range inlines {
		inlines[i].Value = internalutil.MarkdownSourceParser{InlineParser: inlines[i].Value.(parser.InlineParser)}
	}
	p := parser.NewParser(parser.WithBlockParsers(parser.DefaultBlockParsers()...), parser.WithInlineParsers(inlines...), parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...))
	md := goldmark.New(goldmark.WithParser(p), goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.TaskList))
	doc := md.Parser().Parse(text.NewReader([]byte(source)))
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n.Kind() {
		case ast.KindCodeSpan, ast.KindLink, ast.KindImage, ast.KindAutoLink, ast.KindRawHTML:
			start, _ := n.AttributeString("source_start")
			end, _ := n.AttributeString("source_end")
			span := commentLiteral{start.(int), end.(int)}
			excluded = append(excluded, span)
			if n.Kind() == ast.KindCodeSpan {
				literals = append(literals, span)
				return ast.WalkSkipChildren, nil
			}
			// Highlight exclusion must also see code inside a link label.
			return ast.WalkContinue, nil
		case ast.KindCodeBlock, ast.KindFencedCodeBlock, ast.KindHTMLBlock, ast.KindLinkReferenceDefinition:
			start, end := n.Pos(), n.Pos()
			if n.Lines().Len() > 0 {
				start = n.Lines().At(0).Start
				end = n.Lines().At(n.Lines().Len() - 1).Stop
			}
			if n.Kind() == ast.KindFencedCodeBlock {
				start = n.Pos()
				if newline := strings.IndexByte(source[end:], '\n'); newline >= 0 {
					end += newline + 1
				} else {
					end = len(source)
				}
			}
			span := commentLiteral{start, end}
			excluded = append(excluded, span)
			if n.Kind() == ast.KindCodeBlock || n.Kind() == ast.KindFencedCodeBlock {
				literals = append(literals, span)
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	sort.Slice(excluded, func(i, j int) bool { return excluded[i].start < excluded[j].start })
	return
}

// Mirror inline-math.ts delimiter state: a rejected closer becomes a fresh
// opener, and crossing code, links, HTML or a line ending resets the candidate.
func commentMathRanges(source string, excluded []commentLiteral) []commentLiteral {
	var matches []commentLiteral
	opening, rangeIndex := -1, 0
	for cursor := 0; cursor < len(source); cursor++ {
		for rangeIndex < len(excluded) && excluded[rangeIndex].end <= cursor {
			rangeIndex++
		}
		if rangeIndex < len(excluded) && excluded[rangeIndex].start <= cursor {
			opening, cursor = -1, excluded[rangeIndex].end-1
			continue
		}
		if source[cursor] == '\r' || source[cursor] == '\n' {
			opening = -1
			continue
		}
		if source[cursor] != '$' || cursor > 0 && source[cursor-1] == '\\' {
			continue
		}
		if cursor > 0 && source[cursor-1] == '$' || cursor+1 < len(source) && source[cursor+1] == '$' {
			opening = -1
			if strings.HasPrefix(source[cursor:], "$$") {
				if close := strings.Index(source[cursor+2:], "$$"); close >= 0 {
					end := cursor + 2 + close + 2
					if rangeIndex == len(excluded) || excluded[rangeIndex].start >= end {
						matches = append(matches, commentLiteral{cursor, end})
						cursor = end - 1
					}
				}
			}
			continue
		}
		if opening >= 0 && commentMathCanClose(source, cursor) {
			matches = append(matches, commentLiteral{opening, cursor + 1})
			opening = -1
		} else {
			opening = -1
			before, _ := utf8.DecodeLastRuneInString(source[:cursor])
			after, _ := utf8.DecodeRuneInString(source[cursor+1:])
			if !commentMathWord(before) && before != '\\' && before != '$' && cursor+1 < len(source) && after != '$' && !unicode.IsSpace(after) {
				opening = cursor
			}
		}
	}
	return matches
}

func commentMathCanClose(source string, cursor int) bool {
	before, _ := utf8.DecodeLastRuneInString(source[:cursor])
	after, _ := utf8.DecodeRuneInString(source[cursor+1:])
	hardBreak := after == '\\' && cursor+2 < len(source) && strings.ContainsRune("\r\n", rune(source[cursor+2]))
	return before != '\\' && before != '$' && !unicode.IsSpace(before) &&
		(hardBreak || !commentMathWord(after) && after != '\\' && after != '$' && after != '_')
}

func commentMathWord(r rune) bool {
	return r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
}
