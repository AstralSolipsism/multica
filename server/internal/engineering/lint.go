package engineering

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// LintPage supplies the active tree's parent slug alongside the shared wiki body.
type LintPage struct {
	WikiPageContent
	Parent string
	// Attachments are the HTML artifact filenames bound to the page. nil means
	// "not loaded" (offline --dir lint skips existence checks); a non-nil empty
	// slice means the page authoritatively has none.
	Attachments []string
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
				language := string(block.Language(source))
				mermaid := language == "mermaid"
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
				switch language {
				case "mermaid":
					l.lintMermaid(lines)
				case "likec4", "c4":
					l.lintC4Source(lines, fenceOffset(block))
				case "html":
					l.lintHtmlFence(fenceAttribute(fenceInfo(block, source), "src"), fenceOffset(block))
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

func fenceInfo(block *ast.FencedCodeBlock, source []byte) string {
	if block.Info == nil {
		return ""
	}
	return string(block.Info.Segment.Value(source))
}

func fenceOffset(block *ast.FencedCodeBlock) int {
	if block.Info != nil {
		return block.Info.Segment.Start
	}
	if block.Lines().Len() > 0 {
		return block.Lines().At(0).Start
	}
	return 0
}

// lintC4Source accepts `likec4` and `c4` fences as the architecture source of
// truth. Deep structure rules live in the Stage 1B skill tooling; the baseline
// linter only rejects a fence that carries no source at all.
func (l *pageLinter) lintC4Source(lines []lintSourceLine, offset int) {
	for _, line := range lines {
		if strings.TrimSpace(line.text) != "" {
			return
		}
	}
	l.add("error", "c4_source_empty", offset, "C4 source fence is empty; keep the model that renders the canvas attachment")
}

// lintHtmlFence validates the `src="name.html"` reference on an html fence.
// Online lint loads the page's attachment list, so a missing artifact is an
// error (the canvas would silently fall back to the one-line fence body);
// offline --dir lint can only check the reference shape.
func (l *pageLinter) lintHtmlFence(src string, offset int) {
	if src == "" {
		return
	}
	if !attachmentFilename(src) {
		l.add("error", "html_attachment_src", offset, `html fence src must be a bare .html filename, not a path or URL`)
		return
	}
	if l.page.Attachments == nil {
		return
	}
	if !slices.Contains(l.page.Attachments, src) {
		l.add("error", "html_attachment_missing", offset, fmt.Sprintf("html attachment %s is not bound to this page; upload it with `baseline write --attachment %s`", src, src))
	}
}

var attachmentHtmlExt = regexp.MustCompile(`(?i)\.html?$`)
var attachmentURLScheme = regexp.MustCompile(`^[a-z][a-z\d+.-]*:`)

// attachmentFilename mirrors resolveEntityHtmlAttachment on the web: one bare
// filename with an .html/.htm extension.
func attachmentFilename(src string) bool {
	return src != "" &&
		!strings.ContainsAny(src, `/\`) &&
		!attachmentURLScheme.MatchString(src) &&
		attachmentHtmlExt.MatchString(src)
}

// fenceAttribute reads one `name=value` attribute out of a fence info string
// (`html src="architecture.html" title="…"`), accepting single, double or no
// quotes. It mirrors parseFenceMeta in streaming-fence.ts so CLI lint and the
// renderer agree on which attachment a fence names.
func fenceAttribute(info, name string) string {
	for index := 0; index < len(info); {
		for index < len(info) && (info[index] == ' ' || info[index] == '\t' || info[index] == '\n' || info[index] == '\r') {
			index++
		}
		start := index
		for index < len(info) && info[index] != '=' && info[index] != ' ' && info[index] != '\t' && info[index] != '\n' && info[index] != '\r' {
			index++
		}
		key := info[start:index]
		if index >= len(info) || info[index] != '=' {
			continue
		}
		index++
		value := ""
		if index < len(info) && (info[index] == '"' || info[index] == '\'') {
			quote := info[index]
			index++
			valueStart := index
			for index < len(info) && info[index] != quote {
				index++
			}
			value = info[valueStart:index]
			if index < len(info) {
				index++
			}
		} else {
			valueStart := index
			for index < len(info) && info[index] != ' ' && info[index] != '\t' && info[index] != '\n' && info[index] != '\r' {
				index++
			}
			value = info[valueStart:index]
		}
		if key == name {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
