package util

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// UnescapeBackslashEscapes repairs literal paragraph separators in inline CLI
// text and single-line agent output. Markdown code, math and Windows paths are
// copied verbatim. Outside those ranges, command words take precedence over
// control escapes; other \n, \r, \t and \\ sequences are decoded once.
//
// Bare \n followed by prose is inherently ambiguous (line1\nline2). Recognized
// TeX n-commands and command arguments are preserved, while ordinary paragraph
// separators retain their historical behavior. Use file/stdin for exact text.
func UnescapeBackslashEscapes(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	ranges := backslashLiteralRanges(s)
	var b strings.Builder
	b.Grow(len(s))
	r := 0
	for i := 0; i < len(s); i++ {
		if r < len(ranges) && i == ranges[r].start {
			b.WriteString(s[i:ranges[r].end])
			i = ranges[r].end - 1
			r++
			continue
		}
		if end := windowsPathEnd(s, i); end > i {
			if r < len(ranges) && end > ranges[r].start {
				end = ranges[r].start
			}
			b.WriteString(s[i:end])
			i = end - 1
			continue
		}
		if s[i] == '\\' && i+1 < len(s) {
			if end := backslashCommandEnd(s, i); end > i {
				b.WriteString(s[i:end])
				i = end - 1
				continue
			}
			switch s[i+1] {
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case '\\':
				b.WriteByte('\\')
			default:
				b.WriteString(s[i : i+2])
			}
			i++
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

type backslashLiteralRange struct{ start, end int }

func backslashLiteralRanges(s string) []backslashLiteralRange {
	var ranges []backslashLiteralRange
	opening := -1
	escapedLines := !strings.ContainsAny(s, "\r\n")
	codeClosers := inlineCodeClosers(s)
	for i := 0; i < len(s); {
		end := i
		switch {
		case s[i] == '\\':
			i += 2 // Escaped delimiters cannot open or close a literal.
			continue
		case s[i] == '`' || s[i] == '~':
			end = codeLiteralEnd(s, i, escapedLines, codeClosers[i])
			if end == i {
				i += delimiterRun(s, i)
				continue
			}
		case strings.HasPrefix(s[i:], "$$"):
			opening = -1
			for j := i + 2; j < len(s); j++ {
				if s[j] == '\\' {
					j++
				} else if strings.HasPrefix(s[j:], "$$") {
					end = j + 2
					break
				}
			}
			if end == i {
				i += 2
				continue
			}
		case s[i] == '$':
			if opening >= 0 && canCloseInlineMath(s, i) {
				ranges = append(ranges, backslashLiteralRange{opening, i + 1})
				opening = -1
			} else {
				opening = -1
				if canOpenInlineMath(s, i) {
					opening = i
				}
			}
		case s[i] == '\n' || s[i] == '\r':
			opening = -1
		}
		if end > i {
			ranges = append(ranges, backslashLiteralRange{i, end})
			opening = -1
			i = end
		} else {
			i++
		}
	}
	return ranges
}

func windowsPathEnd(s string, i int) int {
	drive := asciiLetter(s[i]) && strings.HasPrefix(s[i+1:], ":\\")
	unc := strings.HasPrefix(s[i:], `\\`) && (i == 0 || spaceBefore(s, i)) && i+2 < len(s) && asciiLetter(s[i+2])
	if !drive && !unc {
		return i
	}
	end := i
	for end < len(s) && !spaceAt(s, end) && !strings.ContainsRune("\"'`<>|$", rune(s[end])) {
		end++
	}
	// A UNC path has a server/share separator. A bare \\n must still decode
	// once to a literal \n, rather than being mistaken for a server name.
	if unc && !strings.ContainsRune(s[i+2:end], '\\') {
		return i
	}
	return end
}

// Index exact-length backtick runs once so unmatched runs do not repeatedly
// search the remainder of a large output. Backslashes are literal inside code.
func inlineCodeClosers(s string) map[int]int {
	closers := make(map[int]int)
	next := make(map[int]int)
	for i := len(s) - 1; i >= 0; {
		if s[i] != '`' {
			i--
			continue
		}
		end := i + 1
		for i >= 0 && s[i] == '`' {
			i--
		}
		start := i + 1
		n := end - start
		if close, ok := next[n]; ok {
			closers[start] = close
		}
		next[n] = end
	}
	return closers
}

func codeLiteralEnd(s string, start int, escapedLines bool, inlineEnd int) int {
	marker := s[start]
	n := delimiterRun(s, start)
	fenced := n >= 3 && fenceLineStart(s, start, escapedLines)
	if fenced && marker == '`' {
		// Backticks in a fence's info string make it an inline code candidate.
		for i := start + n; i < len(s) && s[i] != '\n' && s[i] != '\r'; i++ {
			if escapedLines && strings.HasPrefix(s[i:], `\n`) {
				break
			}
			if s[i] == '`' {
				fenced = false
				break
			}
		}
	}
	if marker == '~' && !fenced {
		return start
	}
	if !fenced {
		if inlineEnd > start {
			return inlineEnd
		}
		return start
	}
	for i := start + n; i < len(s); i++ {
		if s[i] != marker {
			continue
		}
		run := delimiterRun(s, i)
		if run >= n && fenceLineStart(s, i, escapedLines) && fenceLineEnd(s, i+run, escapedLines) {
			return i + run
		}
		i += run - 1
	}
	return len(s)
}

func delimiterRun(s string, i int) int {
	j := i + 1
	for j < len(s) && s[j] == s[i] {
		j++
	}
	return j - i
}

func fenceLineStart(s string, i int, escapedLines bool) bool {
	spaces := 0
	for i > 0 && s[i-1] == ' ' {
		i--
		spaces++
	}
	// Literal newlines also delimit fences in a wholly escaped stdout body.
	return spaces <= 3 && (i == 0 || s[i-1] == '\n' || s[i-1] == '\r' || (escapedLines && i >= 2 && s[i-2:i] == `\n`))
}

func fenceLineEnd(s string, i int, escapedLines bool) bool {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i == len(s) || s[i] == '\n' || s[i] == '\r' || (escapedLines && strings.HasPrefix(s[i:], `\n`))
}

func canOpenInlineMath(s string, i int) bool {
	return (i == 0 || (i >= 2 && s[i-2:i] == `\n`) || (!asciiLetter(s[i-1]) && !asciiDigit(s[i-1]) && s[i-1] != '\\' && s[i-1] != '$')) &&
		i+1 < len(s) && s[i+1] != '$' && !spaceAt(s, i+1)
}

func canCloseInlineMath(s string, i int) bool {
	if i == 0 || s[i-1] == '$' || spaceBefore(s, i) {
		return false
	}
	return i+1 == len(s) || (!asciiLetter(s[i+1]) && !asciiDigit(s[i+1]) && !strings.ContainsRune("\\$_", rune(s[i+1]))) ||
		(s[i+1] == '\\' && i+2 < len(s) && strings.ContainsRune("n\r\n", rune(s[i+2])))
}

func spaceAt(s string, i int) bool {
	r, _ := utf8.DecodeRuneInString(s[i:])
	return unicode.IsSpace(r)
}

func spaceBefore(s string, i int) bool {
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return unicode.IsSpace(r)
}

func asciiLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func asciiDigit(c byte) bool  { return c >= '0' && c <= '9' }

func backslashCommandEnd(s string, i int) int {
	j := i + 1
	for j < len(s) && asciiLetter(s[j]) {
		j++
	}
	if j <= i+2 {
		return i
	}
	if s[i+1] != 'n' || (j < len(s) && s[j] == '{') {
		return j
	}
	// Unlike \t and \r, \n must still work directly before English prose.
	// These TeX control words are meaningful even without math delimiters.
	switch s[i+1 : j] {
	case "nabla", "natural", "ne", "neg", "neq", "newline", "newcommand", "newenvironment",
		"nexists", "ni", "not", "notin", "nparallel", "nmid", "nleq", "ngeq", "nless", "ngtr",
		"nsubseteq", "nsupseteq", "ntriangleleft", "ntriangleright", "nu", "null", "nwarrow", "nearrow":
		return j
	}
	return i
}
