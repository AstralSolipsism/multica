package engineering

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// Slug/page limits mirror the CHECK constraints added by migration 9067.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

const (
	MaxWikiDepth      = 6
	MaxWikiPages      = 500
	MaxWikiSiblings   = 200
	maxWikiTitleRunes = 200
)

func ValidSlug(slug string) bool {
	return slugPattern.MatchString(slug) && !uuidPattern.MatchString(slug)
}

func ValidWikiTitle(title string) bool {
	n := utf8.RuneCountInString(title)
	return n >= 1 && n <= maxWikiTitleRunes && !strings.ContainsAny(title, "\r\n\x00")
}

// WikiPageContent is one unarchived page's identity plus its current body.
type WikiPageContent struct {
	Slug    string
	Title   string
	Content string
}

// WikiSectionAddr locates one heading inside the index.
type WikiSectionAddr struct {
	Page   int
	Anchor string
	Title  string
}

// WikiIndex is the per-request project symbol table: slugs, unarchived titles
// and every section anchor. Tree section listings, forward links, backlinks,
// search and Project Context all resolve through this one table so the
// directions can never disagree (contract §7.2).
type WikiIndex struct {
	Pages    []WikiPageContent
	bySlug   map[string]int
	byTitle  map[string][]int
	sections map[int][]Heading
	byAnchor map[string][]WikiSectionAddr
}

func NewWikiIndex(pages []WikiPageContent) *WikiIndex {
	idx := &WikiIndex{
		Pages:    pages,
		bySlug:   map[string]int{},
		byTitle:  map[string][]int{},
		sections: map[int][]Heading{},
		byAnchor: map[string][]WikiSectionAddr{},
	}
	for i, p := range pages {
		idx.bySlug[p.Slug] = i
		idx.byTitle[strings.ToLower(p.Title)] = append(idx.byTitle[strings.ToLower(p.Title)], i)
		headings, err := Index(p.Content)
		if err != nil {
			continue
		}
		idx.sections[i] = headings
		// A heading registers its anchor key and its title; identical keys
		// collapse so one section never double-counts toward ambiguity.
		seen := map[string]bool{}
		for _, h := range headings {
			for _, key := range []string{strings.ToLower(h.Anchor), strings.ToLower(h.Title)} {
				if key == "" || seen[key] {
					continue
				}
				seen[key] = true
				idx.byAnchor[key] = append(idx.byAnchor[key], WikiSectionAddr{i, h.Anchor, h.Title})
			}
		}
	}
	return idx
}

func (idx *WikiIndex) SectionHeadings(page int) []Heading {
	if headings, ok := idx.sections[page]; ok {
		return headings
	}
	return []Heading{}
}

// WikiLink is one parsed `[[…]]` occurrence with its resolution state.
type WikiLink struct {
	Raw           string   `json:"raw"`
	Display       string   `json:"display"`
	Target        string   `json:"target"`
	Section       string   `json:"section"`
	Kind          string   `json:"kind"`  // page | stage
	State         string   `json:"state"` // resolved | ambiguous | missing
	TargetSlug    string   `json:"target_slug,omitempty"`
	SectionAnchor string   `json:"section_anchor,omitempty"`
	Candidates    []string `json:"candidates,omitempty"`
}

var wikiLinkTextPattern = regexp.MustCompile(`\[\[([^\[\]\r\n]+)\]\]`)
var stageLinkPattern = regexp.MustCompile(`^stage:([1-9][0-9]*)$`)

// ParseWikiLinkRaw splits the inside of one `[[…]]` into target/section/display.
func ParseWikiLinkRaw(raw string) (target, section, display string) {
	target, display = raw, raw
	if before, after, found := strings.Cut(raw, "|"); found {
		target, display = before, before
		if strings.TrimSpace(after) != "" {
			display = after
		}
	}
	section = ""
	if before, after, found := strings.Cut(target, "#"); found {
		target, section = before, after
	}
	return strings.TrimSpace(target), strings.TrimSpace(section), strings.TrimSpace(display)
}

// ResolveWikiLink resolves one link for the page it appears on.
func (idx *WikiIndex) ResolveWikiLink(fromPage int, raw string) WikiLink {
	target, section, display := ParseWikiLinkRaw(raw)
	link := WikiLink{Raw: raw, Display: display, Target: target, Section: section, Kind: "page"}
	if stageLinkPattern.MatchString(raw) {
		link.Kind = "stage"
		link.State = "resolved"
		return link
	}
	if target == "" {
		// `[[#section]]` stays on the current page.
		if fromPage < 0 || fromPage >= len(idx.Pages) {
			link.State = "missing"
			return link
		}
		return idx.resolveSection(link, fromPage)
	}
	if i, ok := idx.bySlug[target]; ok {
		if section == "" {
			link.State, link.TargetSlug = "resolved", idx.Pages[i].Slug
			return link
		}
		return idx.resolveSection(link, i)
	}
	if matches := idx.byTitle[strings.ToLower(target)]; len(matches) > 0 {
		if len(matches) > 1 {
			link.State = "ambiguous"
			for _, i := range matches {
				link.Candidates = append(link.Candidates, idx.Pages[i].Slug)
			}
			return link
		}
		i := matches[0]
		if section == "" {
			link.State, link.TargetSlug = "resolved", idx.Pages[i].Slug
			return link
		}
		return idx.resolveSection(link, i)
	}
	if section == "" {
		// Legacy `[[唯一小节名]]`: a project-wide unique section still resolves.
		if addrs := idx.byAnchor[strings.ToLower(target)]; len(addrs) == 1 {
			addr := addrs[0]
			link.State, link.TargetSlug, link.SectionAnchor = "resolved", idx.Pages[addr.Page].Slug, addr.Anchor
			return link
		} else if len(addrs) > 1 {
			seen := map[string]bool{}
			for _, addr := range addrs {
				if slug := idx.Pages[addr.Page].Slug; !seen[slug] {
					seen[slug] = true
					link.Candidates = append(link.Candidates, slug)
				}
			}
			if len(link.Candidates) > 1 {
				link.State = "ambiguous"
				return link
			}
		}
	}
	link.State = "missing"
	return link
}

func (idx *WikiIndex) resolveSection(link WikiLink, page int) WikiLink {
	for _, h := range idx.sections[page] {
		if strings.EqualFold(h.Anchor, link.Section) || strings.EqualFold(h.Title, link.Section) {
			link.State, link.TargetSlug, link.SectionAnchor = "resolved", idx.Pages[page].Slug, h.Anchor
			return link
		}
	}
	link.TargetSlug, link.State = idx.Pages[page].Slug, "missing"
	return link
}

var wikiMarkdownParser = goldmark.New(goldmark.WithParserOptions(parser.WithAutoHeadingID()))

// ExtractWikiLinks walks the goldmark AST and returns every `[[…]]` occurrence
// in document order. Inline code and fenced code blocks never produce links.
// Unmatched brackets arrive as separate sibling Text nodes, so adjacent text is
// joined and every structural node boundary flushes the buffer.
func ExtractWikiLinks(content string) []string {
	if !strings.Contains(content, "[[") {
		return nil
	}
	source := []byte(content)
	doc := wikiMarkdownParser.Parser().Parse(text.NewReader(source))
	var out []string
	var buf strings.Builder
	flush := func() {
		if buf.Len() == 0 {
			return
		}
		for _, m := range wikiLinkTextPattern.FindAllStringSubmatch(buf.String(), -1) {
			out = append(out, m[1])
		}
		buf.Reset()
	}
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n.Kind() {
		case ast.KindText, ast.KindString:
			buf.WriteString(string(n.Text(source)))
		case ast.KindCodeBlock, ast.KindFencedCodeBlock, ast.KindCodeSpan:
			flush()
			return ast.WalkSkipChildren, nil
		default:
			flush()
		}
		return ast.WalkContinue, nil
	})
	flush()
	return out
}

// LinksFor resolves every link on one page.
func (idx *WikiIndex) LinksFor(page int) []WikiLink {
	raws := ExtractWikiLinks(idx.Pages[page].Content)
	out := make([]WikiLink, 0, len(raws))
	for _, raw := range raws {
		out = append(out, idx.ResolveWikiLink(page, raw))
	}
	return out
}

// Backlink is one inbound reference to a page.
type Backlink struct {
	Slug          string `json:"slug"`
	Title         string `json:"title"`
	SectionAnchor string `json:"section_anchor,omitempty"`
	Snippet       string `json:"snippet"`
}

func wikiLinkSnippet(content, raw string) string {
	at := strings.Index(content, "[["+raw+"]]")
	if at < 0 {
		at = 0
	}
	start, end := at, at+len(raw)+4
	start = max(0, start-60)
	end = min(len(content), end+60)
	snippet := strings.Join(strings.Fields(content[start:end]), " ")
	if utf8.RuneCountInString(snippet) > 160 {
		snippet = string([]rune(snippet)[:160])
	}
	return snippet
}

// BacklinksFor returns every other page's resolved links pointing at slug.
// Ambiguous and missing links count toward nobody, matching linksFor.
func (idx *WikiIndex) BacklinksFor(slug string) []Backlink {
	target, ok := idx.bySlug[slug]
	if !ok {
		return []Backlink{}
	}
	out := []Backlink{}
	for i, p := range idx.Pages {
		if i == target {
			continue
		}
		if !strings.Contains(p.Content, "[[") {
			continue
		}
		for _, link := range idx.LinksFor(i) {
			if link.Kind != "page" || link.State != "resolved" || link.TargetSlug != slug {
				continue
			}
			out = append(out, Backlink{Slug: p.Slug, Title: p.Title, SectionAnchor: link.SectionAnchor, Snippet: wikiLinkSnippet(p.Content, link.Raw)})
		}
	}
	return out
}

// SearchHit is one full-text search result (contract §7.3).
type SearchHit struct {
	PageID        string `json:"page_id"`
	Slug          string `json:"slug"`
	Title         string `json:"title"`
	SectionAnchor string `json:"section_anchor,omitempty"`
	SectionTitle  string `json:"section_title,omitempty"`
	Snippet       string `json:"snippet"`
	Match         string `json:"match"` // title | section | body
}

// SearchSnippet maps a lowercased-content hit offset to its section and builds
// the ±60 rune snippet. match selects whether the title or body matched.
func SearchSnippet(pageID, slug, title, content, query, match string) SearchHit {
	lower := strings.ToLower(content)
	needle := strings.ToLower(query)
	offset := strings.Index(lower, needle)
	anchor, sectionTitle := "", ""
	headings := scanHeadings(content)
	current := Heading{}
	for _, h := range headings {
		if h.start <= offset {
			current = h.Heading
		} else {
			break
		}
	}
	anchor, sectionTitle = current.Anchor, current.Title
	if match == "section" {
		for _, h := range headings {
			if strings.Contains(strings.ToLower(h.Title), needle) {
				anchor, sectionTitle, offset = h.Anchor, h.Title, h.start
				break
			}
		}
	}
	if offset < 0 {
		offset = 0
	}
	start := offset - 60
	if start < 0 {
		start = 0
	}
	end := offset + len(needle) + 60
	if end > len(content) {
		end = len(content)
	}
	for start > 0 && start < len(content) && !utf8.RuneStart(content[start]) {
		start--
	}
	for end < len(content) && !utf8.RuneStart(content[end]) {
		end++
	}
	snippet := strings.Join(strings.Fields(content[start:end]), " ")
	if utf8.RuneCountInString(snippet) > 160 {
		snippet = string([]rune(snippet)[:160])
	}
	return SearchHit{PageID: pageID, Slug: slug, Title: title, SectionAnchor: anchor, SectionTitle: sectionTitle, Snippet: snippet, Match: match}
}
