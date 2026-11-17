package engineering

import (
	"fmt"
	"html"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type lintSourceLine struct {
	text   string
	offset int
}
type lintEdge struct{ from, to string }
type lintGraph struct {
	offset   int
	nodes    map[string]bool
	edges    []lintEdge
	groups   map[string]map[string]bool
	complete bool
}

var mermaidFlow = regexp.MustCompile(`^(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)(?:\s|$)`)
var mermaidColor = regexp.MustCompile(`(?i)(?:fill|stroke|color)\s*:\s*#[0-9a-f]+`)
var mermaidLeak = regexp.MustCompile(`(?i)REQ-\d+|#L\d+|第[一二三四五六七八九十0-9]+步|\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b|\b(?:SELECT\s+.+\s+FROM|CREATE\s+TABLE|[a-z_][a-z0-9_]*\s+(?:varchar|bigint|integer|boolean|timestamp|text|int)\b)`)
var mermaidBreak = regexp.MustCompile(`(?i)<br\s*/?>|\\n`)
var mermaidTag = regexp.MustCompile(`<[^>]*>`)
var mermaidArrow = regexp.MustCompile(`^(?:<)?(?:--+|==+|-\.+-)(?:>|o|x)?|^~~~`)

func normalizedNode(id string) string { return strings.ReplaceAll(id, "-", "_") }
func mermaidIDByte(b byte) bool {
	return b > 127 || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '-'
}

// Statements respect quoted labels and shapes, so arrows/semicolons in a label
// cannot manufacture nodes or edges. This is a topology reader, not a renderer.
func mermaidStatements(lines []lintSourceLine) []lintSourceLine {
	var out []lintSourceLine
	var buf strings.Builder
	offset, depth := 0, 0
	var quote rune
	flush := func() {
		if value := strings.TrimSpace(buf.String()); value != "" {
			out = append(out, lintSourceLine{value, offset})
		}
		buf.Reset()
	}
	for _, line := range lines {
		escaped := false
		for i, r := range line.text {
			if buf.Len() == 0 {
				offset = line.offset + i
			}
			if quote != 0 {
				buf.WriteRune(r)
				if r == quote && !escaped {
					quote = 0
				}
				if r == '\\' {
					escaped = !escaped
				} else {
					escaped = false
				}
				continue
			}
			if r == '"' || r == '`' {
				quote = r
				buf.WriteRune(r)
				continue
			}
			if r == '%' && strings.HasPrefix(line.text[i:], "%%") {
				break
			}
			if r == '[' || r == '(' || r == '{' {
				depth++
			}
			if r == ']' || r == ')' || r == '}' {
				depth = max(0, depth-1)
			}
			if (r == ';' || r == '\n' || r == '\r') && depth == 0 {
				flush()
			} else {
				buf.WriteRune(r)
			}
		}
		if depth == 0 && quote == 0 {
			flush()
		} else {
			buf.WriteByte('\n')
		}
	}
	flush()
	return out
}

func (l *pageLinter) lintMermaid(lines []lintSourceLine) {
	statements := mermaidStatements(lines)
	if len(statements) == 0 {
		return
	}
	// Mermaid permits a YAML configuration header before the diagram declaration.
	if statements[0].text == "---" {
		for i := 1; i < len(statements); i++ {
			if statements[i].text == "---" {
				statements = statements[i+1:]
				break
			}
		}
		if len(statements) == 0 {
			return
		}
	}
	flow := mermaidFlow.MatchString(statements[0].text)
	g := lintGraph{offset: statements[0].offset, nodes: map[string]bool{}, groups: map[string]map[string]bool{}, complete: true}
	if !flow {
		// Other diagram types use braces for blocks rather than node shapes.
		// Inspect their lines so nested state/class blocks cannot hide colors.
		statements = nil
		for _, line := range lines {
			statements = append(statements, mermaidStatements([]lintSourceLine{line})...)
		}
	}
	var stack []string
	labels := map[string]lintSourceLine{}
	groups := map[string]bool{}
	for _, s := range statements {
		fields := strings.Fields(s.text)
		if len(fields) == 0 {
			continue
		}
		keyword := fields[0]
		if (keyword == "style" || keyword == "classDef" || keyword == "linkStyle") && mermaidColor.MatchString(s.text) {
			l.add("error", "mermaid_color", s.offset, "Remove hexadecimal colors; use the native Mermaid light/dark theme")
		}
		if !flow {
			continue
		}
		switch keyword {
		case "flowchart", "graph", "direction", "style", "classDef", "class", "linkStyle", "click":
			continue
		case "subgraph":
			rest := strings.TrimSpace(strings.TrimPrefix(s.text, "subgraph"))
			id, _, _, ok := readMermaidNode(rest)
			if !ok {
				g.complete = false
				continue
			}
			groups[id] = true
			id = normalizedNode(id)
			if len(stack) > 0 {
				g.groups[stack[0]][id] = true
			}
			if len(stack) == 0 {
				g.groups[id] = map[string]bool{}
			}
			stack = append(stack, id)
			continue
		case "end":
			if len(stack) == 0 {
				g.complete = false
			} else {
				stack = stack[:len(stack)-1]
			}
			continue
		}
		rest := s.text
		readNodes := func() ([]string, bool) {
			var ids []string
			for {
				id, label, tail, ok := readMermaidNode(strings.TrimSpace(rest))
				if !ok {
					return ids, false
				}
				if _, exists := labels[id]; label != "" || !exists {
					display := label
					if display == "" {
						display = id
					}
					labels[id] = lintSourceLine{display, s.offset}
				}
				id = normalizedNode(id)
				g.nodes[id] = true
				if len(stack) > 0 {
					g.groups[stack[0]][id] = true
				}
				ids = append(ids, id)
				rest = strings.TrimSpace(tail)
				if !strings.HasPrefix(rest, "&") {
					return ids, true
				}
				rest = strings.TrimSpace(rest[1:])
			}
		}
		from, ok := readNodes()
		for ok && rest != "" {
			edge, label, tail, found := readMermaidEdge(rest)
			if !found {
				ok = false
				break
			}
			if strings.Contains(label, "...") || strings.Contains(label, "…") {
				l.add("error", "mermaid_edge_ellipsis", s.offset, "Replace edge-label ellipses with a concrete interaction")
			}
			rest = tail
			var to []string
			to, ok = readNodes()
			if !ok {
				break
			}
			for _, a := range from {
				for _, b := range to {
					if strings.HasSuffix(edge, ">") || strings.HasSuffix(edge, "o") || strings.HasSuffix(edge, "x") {
						g.edges = append(g.edges, lintEdge{a, b})
					}
					if strings.HasPrefix(edge, "<") {
						g.edges = append(g.edges, lintEdge{b, a})
					}
				}
			}
			from = to
		}
		if !ok {
			g.complete = false
		}
	}
	if !flow {
		return
	}
	if len(stack) > 0 {
		g.complete = false
	}
	// Subgraphs describe boundaries, not additional business nodes.
	for id := range groups {
		delete(g.nodes, normalizedNode(id))
		delete(labels, id)
	}
	for _, label := range labels {
		l.lintNodeLabel(label.text, label.offset)
	}
	if len(labels) > 7 {
		l.add("error", "mermaid_node_limit", g.offset, fmt.Sprintf("Diagram has %d nodes (maximum 7); split complex containers into child pages", len(labels)))
	}
	if !g.complete {
		l.add("warning", "mermaid_topology_unchecked", g.offset, "Topology could not be fully read; use simple node/edge/subgraph statements before relying on boundary reconciliation")
	}
	l.graphs = append(l.graphs, g)
}

func readMermaidNode(s string) (id, label, rest string, ok bool) {
	n := 0
	for n < len(s) && mermaidIDByte(s[n]) {
		if s[n] == '-' && n+1 < len(s) && (s[n+1] == '-' || s[n+1] == '.' || s[n+1] == '>') {
			break
		}
		n++
	}
	if n == 0 {
		return "", "", s, false
	}
	id, rest = s[:n], strings.TrimSpace(s[n:])
	if len(rest) > 0 && strings.ContainsRune("[({>", rune(rest[0])) {
		var stack []byte
		var quote byte
		end := 0
		for end < len(rest) {
			c := rest[end]
			if quote != 0 {
				if c == quote && (end == 0 || rest[end-1] != '\\') {
					quote = 0
				}
			} else if c == '"' || c == '`' {
				quote = c
			} else {
				switch c {
				case '[':
					stack = append(stack, ']')
				case '(':
					stack = append(stack, ')')
				case '{':
					stack = append(stack, '}')
				case '>':
					if end == 0 {
						stack = append(stack, ']')
					}
				case ']', ')', '}':
					if len(stack) == 0 || stack[len(stack)-1] != c {
						return "", "", s, false
					}
					stack = stack[:len(stack)-1]
				}
			}
			end++
			if len(stack) == 0 && quote == 0 {
				break
			}
		}
		if len(stack) > 0 || quote != 0 {
			return "", "", s, false
		}
		label = strings.Trim(rest[:end], "[](){}>\"`/\\")
		rest = strings.TrimSpace(rest[end:])
	}
	if strings.HasPrefix(rest, ":::") {
		rest = rest[3:]
		n = 0
		for n < len(rest) && (mermaidIDByte(rest[n]) || rest[n] == ',') {
			n++
		}
		rest = strings.TrimSpace(rest[n:])
	}
	return id, label, rest, true
}

func readMermaidEdge(s string) (edge, label, rest string, ok bool) {
	for _, pair := range [][2]string{{"-- ", "-->"}, {"-. ", ".->"}, {"== ", "==>"}} {
		if strings.HasPrefix(s, pair[0]) {
			if n := strings.Index(s[len(pair[0]):], pair[1]); n >= 0 {
				n += len(pair[0])
				return pair[1], strings.TrimSpace(s[len(pair[0]):n]), strings.TrimSpace(s[n+len(pair[1]):]), true
			}
		}
	}
	edge = mermaidArrow.FindString(s)
	if edge == "" {
		return "", "", s, false
	}
	rest = strings.TrimSpace(s[len(edge):])
	if strings.HasPrefix(rest, "|") {
		end := strings.Index(rest[1:], "|")
		if end < 0 {
			return "", "", s, false
		}
		label, rest = rest[1:end+1], strings.TrimSpace(rest[end+2:])
	}
	return edge, label, rest, true
}

func (l *pageLinter) lintNodeLabel(label string, offset int) {
	plain := html.UnescapeString(mermaidTag.ReplaceAllString(mermaidBreak.ReplaceAllString(label, "\n"), ""))
	if mermaidLeak.MatchString(plain) {
		l.add("error", "mermaid_implementation_detail", offset, "Keep node labels at responsibility level; remove requirement IDs, SQL fields, code locations or numbered steps")
	}
	total, longest := 0, 0
	for _, line := range strings.Split(plain, "\n") {
		width := 0
		for _, r := range strings.TrimSpace(line) {
			if unicode.Is(unicode.Mn, r) || r == '\u200d' {
				continue
			}
			if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hangul, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || r >= 0xff01 && r <= 0xff60 || r >= 0x3000 && r <= 0x303f {
				width += 2
			} else if r != utf8.RuneError {
				width++
			}
		}
		total += width
		longest = max(longest, width)
	}
	if total > 72 || longest > 44 {
		l.add("error", "mermaid_label_length", offset, "Shorten node text to 36 CJK characters total and 22 per line (Latin characters count half)")
	}
}

func boundaryPeers(g lintGraph, inside map[string]bool) (map[string]bool, map[string]bool) {
	in, out := map[string]bool{}, map[string]bool{}
	for _, e := range g.edges {
		if !inside[e.from] && inside[e.to] {
			in[e.from] = true
		}
		if inside[e.from] && !inside[e.to] {
			out[e.to] = true
		}
	}
	return in, out
}

func (l *pageLinter) lintConservation(child *pageLinter) {
	id := normalizedNode(child.page.Slug)
	for _, parentGraph := range l.graphs {
		if !parentGraph.complete || !parentGraph.nodes[id] {
			continue
		}
		pin, pout := boundaryPeers(parentGraph, map[string]bool{id: true})
		for _, childGraph := range child.graphs {
			inside, ok := childGraph.groups[id]
			if !ok || !childGraph.complete {
				continue
			}
			// A direct edge to the container itself crosses the same boundary.
			members := map[string]bool{id: true}
			for member := range inside {
				members[member] = true
			}
			cin, cout := boundaryPeers(childGraph, members)
			for _, direction := range []struct {
				name          string
				parent, child map[string]bool
			}{{"incoming", pin, cin}, {"outgoing", pout, cout}} {
				var missing, extra []string
				for peer := range direction.parent {
					if !direction.child[peer] {
						missing = append(missing, peer)
					}
				}
				for peer := range direction.child {
					if !direction.parent[peer] {
						extra = append(extra, peer)
					}
				}
				sort.Strings(missing)
				sort.Strings(extra)
				if len(missing)+len(extra) == 0 {
					continue
				}
				child.add("error", "boundary_conservation", childGraph.offset, fmt.Sprintf("%s -> %s %s peers: missing [%s]; extra [%s]", l.page.Slug, child.page.Slug, direction.name, strings.Join(missing, ", "), strings.Join(extra, ", ")))
				child.diagnostics[len(child.diagnostics)-1].relatedPage = l.page.Slug
			}
		}
	}
}
