package engineering

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// LintPage supplies the active tree's parent slug alongside the shared wiki body.
type LintPage struct {
	WikiPageContent
	Parent string
}

type LintDiagnostic struct {
	Severity    string `json:"severity"`
	Code        string `json:"code"`
	Page        string `json:"page"`
	Section     string `json:"section"`
	Line        int    `json:"line"`
	Message     string `json:"message"`
	relatedPage string
}

type LintResult struct {
	OK           bool             `json:"ok"`
	ErrorCount   int              `json:"error_count"`
	WarningCount int              `json:"warning_count"`
	Diagnostics  []LintDiagnostic `json:"diagnostics"`
}

type pageLinter struct {
	page        LintPage
	headings    []documentHeading
	diagnostics []LintDiagnostic
	graphs      []lintGraph
	links       map[string]bool
}

func (l *pageLinter) add(severity, code string, offset int, message string) {
	section := ""
	for _, h := range l.headings {
		if h.start > offset {
			break
		}
		section = h.Anchor
	}
	l.diagnostics = append(l.diagnostics, LintDiagnostic{
		Severity: severity, Code: code, Page: l.page.Slug, Section: section,
		Line: 1 + strings.Count(l.page.Content[:min(max(offset, 0), len(l.page.Content))], "\n"), Message: message,
	})
}

// Lint checks a complete active snapshot. page only filters diagnostics, never
// inputs: links and parent/child edges still need the rest of the project.
func Lint(pages []LintPage, page string) LintResult {
	bodies := make([]WikiPageContent, len(pages))
	for i, p := range pages {
		bodies[i] = p.WikiPageContent
	}
	index := NewWikiIndex(bodies)
	linters := make([]pageLinter, len(pages))
	for i, p := range pages {
		l := &linters[i]
		*l = pageLinter{page: p, headings: scanHeadings(p.Content), links: map[string]bool{}}
		if err := validate(p.Content); err != nil {
			l.add("error", "page_content", 0, err.Error())
			continue
		}
		extractWikiLinks(p.Content, func(raw string, offset int) {
			link := index.ResolveWikiLink(i, raw)
			if link.State != "resolved" {
				l.add("error", "wiki_link_"+link.State, offset, fmt.Sprintf("[[%s]]: %s page or section", raw, link.State))
			} else if link.Kind == "page" {
				l.links[link.TargetSlug] = true
			}
		})
		source := []byte(p.Content)
		doc := wikiMarkdownParser.Parser().Parse(text.NewReader(source))
		ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
			if !entering {
				return ast.WalkContinue, nil
			}
			if block, ok := n.(*ast.FencedCodeBlock); ok {
				var lines []lintSourceLine
				mermaid := string(block.Language(source)) == "mermaid"
				for j := 0; j < block.Lines().Len(); j++ {
					segment := block.Lines().At(j)
					value := string(segment.Value(source))
					lines = append(lines, lintSourceLine{value, segment.Start})
					for _, m := range wikiLinkTextPattern.FindAllStringIndex(value, -1) {
						// Mermaid's native subprocess shape ID[[label]] is not a wiki link.
						if mermaid && m[0] > 0 && mermaidIDByte(value[m[0]-1]) {
							continue
						}
						l.add("warning", "wiki_link_in_fence", segment.Start+m[0], "Move [[...]] to a navigation line immediately below the diagram; fenced links have no preview or backlinks")
					}
				}
				if mermaid {
					l.lintMermaid(lines)
				}
				return ast.WalkSkipChildren, nil
			}
			return ast.WalkContinue, nil
		})
		l.lintGates(doc, source)
	}
	for i := range linters {
		parent := &linters[i]
		if len(parent.graphs) == 0 {
			continue
		}
		for j := range linters {
			child := &linters[j]
			if child.page.Parent != parent.page.Slug {
				continue
			}
			if !parent.links[child.page.Slug] {
				parent.add("error", "child_navigation", parent.graphs[0].offset, fmt.Sprintf("Add [[%s]] outside the diagram to navigate to this child page", child.page.Slug))
			}
			parent.lintConservation(child)
		}
	}
	out := LintResult{OK: true, Diagnostics: []LintDiagnostic{}}
	for _, l := range linters {
		for _, d := range l.diagnostics {
			if page != "" && d.Page != page && d.relatedPage != page {
				continue
			}
			out.Diagnostics = append(out.Diagnostics, d)
			if d.Severity == "error" {
				out.ErrorCount++
			} else {
				out.WarningCount++
			}
		}
	}
	sort.SliceStable(out.Diagnostics, func(i, j int) bool {
		a, b := out.Diagnostics[i], out.Diagnostics[j]
		if a.Page != b.Page {
			return a.Page < b.Page
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		return a.Message < b.Message
	})
	out.OK = out.ErrorCount == 0
	return out
}

var gateFields = []string{"对外开口", "唯一记忆事实", "死守底线", "外部默认前提"}
var gateItemPattern = regexp.MustCompile(`^(\s*)(?:[-+*]|[0-9]+[.)])\s+(.*)$`)
var gateCounterexample = regexp.MustCompile(`反例\s*[：:]\s*\S|(?:若|如果|当).+(?:则|就|即).*(?:违规|失败|破防|不允许)|.+(?:即|就|算|视为|判为|属于)违规`)

func (l *pageLinter) lintGates(doc ast.Node, source []byte) {
	// Restrict markers to actual Markdown list items; fenced examples and prose
	// mentioning a gate do not opt an ordinary BDD section into this contract.
	listLines := map[int]bool{}
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering && n.Kind() == ast.KindListItem {
			if first := n.FirstChild(); first != nil && first.Lines().Len() > 0 {
				pos := first.Lines().At(0).Start
				start := strings.LastIndex(l.page.Content[:pos], "\n") + 1
				listLines[start] = true
			}
		}
		return ast.WalkContinue, nil
	})
	headings := append([]documentHeading{{Heading: Heading{}, bodyStart: 0, ownEnd: len(l.page.Content)}}, l.headings...)
	if len(l.headings) > 0 {
		headings[0].ownEnd = l.headings[0].start
	}
	for _, h := range headings {
		values := map[string]string{}
		bold := map[string]bool{}
		current, indent := "", 0
		offset := h.bodyStart
		hasList := false
		for _, line := range strings.Split(l.page.Content[h.bodyStart:h.ownEnd], "\n") {
			m := gateItemPattern.FindStringSubmatch(line)
			if m != nil && listLines[offset] {
				hasList = true
				key := ""
				content := strings.TrimSpace(m[2])
				for _, field := range gateFields {
					stripped := strings.TrimPrefix(content, "**")
					if strings.HasPrefix(stripped, field) {
						tail := strings.TrimPrefix(stripped, field)
						if tail == "" || strings.HasPrefix(tail, "**") || strings.HasPrefix(tail, ":") || strings.HasPrefix(tail, "：") {
							key = field
							bold[field] = bold[field] || strings.HasPrefix(content, "**"+field+"**") || strings.HasPrefix(content, "**"+field+"：**") || strings.HasPrefix(content, "**"+field+":**")
							break
						}
					}
				}
				if key != "" {
					current, indent = key, len(m[1])
					values[key] += content + "\n"
				} else if current != "" && len(m[1]) > indent {
					values[current] += content + "\n"
				} else {
					current = ""
				}
			} else if current != "" && strings.TrimSpace(line) != "" {
				if len(line)-len(strings.TrimLeft(line, " \t")) > indent {
					values[current] += line + "\n"
				} else {
					current = ""
				}
			}
			offset += len(line) + 1
		}
		count := 0
		for _, v := range bold {
			if v {
				count++
			}
		}
		if !hasList || !strings.Contains(h.Title, "门规") && count < 2 {
			continue
		}
		for _, field := range gateFields {
			if _, ok := values[field]; !ok {
				l.add("error", "gate_missing_field", h.start, "Boundary gate is missing "+field)
			}
		}
		if bottom, ok := values["死守底线"]; ok && !gateCounterexample.MatchString(strings.ReplaceAll(bottom, "**", "")) {
			l.add("error", "gate_counterexample", h.start, "死守底线 needs a concrete 反例: ... or an explicit violation condition in its item/sublist")
		}
	}
}
