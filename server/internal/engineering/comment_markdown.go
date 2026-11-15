package engineering

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

type commentLiteral struct {
	start, end int
	math       bool
}

var commentMath = regexp.MustCompile(`(?s)\$\$.*?\$\$|\$[^$\r\n]+\$`)
var commentBlankLine = regexp.MustCompile(`\r?\n[ \t]*\r?\n`)

// The source-level highlight rules mirror editor/utils/highlight-match.ts:
// no inner edge whitespace, no blank lines, and no delimiters inside literals.
// Math is indexed as authored source, atomically, just like data-math-source.
func commentMarkdown(source string) string {
	if !strings.Contains(source, "==") && !strings.Contains(source, "$") {
		return source
	}
	literals := commentLiteralRanges(source)
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
	for _, span := range literals {
		if span.math {
			maths[span.start] = span.end
		}
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

func commentLiteralRanges(source string) []commentLiteral {
	input := []byte(source)
	doc := wikiMarkdownParser.Parser().Parse(text.NewReader(input))
	var spans []commentLiteral
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n.Kind() {
		case ast.KindCodeSpan:
			start := n.Pos()
			run := 0
			for start+run < len(source) && source[start+run] == '`' {
				run++
			}
			if run > 0 {
				// The parser has already found the matching run, including spans
				// with longer backtick runs inside their code.
				contentEnd := n.LastChild().(*ast.Text).Segment.Stop
				end := strings.Index(source[contentEnd:], strings.Repeat("`", run))
				if end >= 0 {
					spans = append(spans, commentLiteral{start, contentEnd + end + run, false})
				}
			}
			return ast.WalkSkipChildren, nil
		case ast.KindCodeBlock, ast.KindFencedCodeBlock:
			start, end := n.Pos(), n.Pos()
			if n.Lines().Len() > 0 {
				end = n.Lines().At(n.Lines().Len() - 1).Stop
			}
			if n.Kind() == ast.KindFencedCodeBlock {
				if newline := strings.IndexByte(source[end:], '\n'); newline >= 0 {
					end += newline + 1
				} else {
					end = len(source)
				}
			}
			spans = append(spans, commentLiteral{start, end, false})
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	for _, match := range commentMath.FindAllStringIndex(source, -1) {
		start, end := match[0], match[1]
		blocked := false
		for _, span := range spans {
			if start < span.end && end > span.start {
				blocked = true
			}
		}
		if blocked {
			continue
		}
		isMath := start == 0 || source[start-1] != '\\'
		if !strings.HasPrefix(source[start:], "$$") {
			if start > 0 && source[start-1] == '$' || end < len(source) && source[end] == '$' {
				continue
			}
			first, _ := utf8.DecodeRuneInString(source[start+1:])
			last, _ := utf8.DecodeLastRuneInString(source[:end-1])
			asciiWord := func(b byte) bool { return b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }
			if unicode.IsSpace(first) || unicode.IsSpace(last) || last == '\\' ||
				start > 0 && asciiWord(source[start-1]) || end < len(source) && (asciiWord(source[end]) || strings.ContainsRune("_$\\", rune(source[end]))) {
				isMath = false
			}
		}
		spans = append(spans, commentLiteral{start, end, isMath})
	}
	return spans
}
