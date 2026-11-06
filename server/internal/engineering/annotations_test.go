package engineering

import (
	"html"
	"strings"
	"testing"
)

func TestAnnotationOwnSourceAndRelocation(t *testing.T) {
	const source = "## [RULE-1] Rules\r\n  keep spaces  \r\n\r\n### Child\r\nchild\r\n## Other\r\nbody"
	s, ok := FindAnnotationSection("domain_rules", source, "RULE-1")
	if !ok || len(SourceLines(s.OwnMarkdown)) != 3 || SourceLines(s.OwnMarkdown)[1] != "  keep spaces  " || !strings.Contains(s.ContentMarkdown, "child") {
		t.Fatalf("raw own/subtree boundaries: %+v", s)
	}
	if _, ok := FindAnnotationSection("domain_rules", source, "Rules"); ok {
		t.Fatal("title matched a different stable anchor")
	}
	if sections := AnnotationSubtrees("domain_rules", source, map[string]bool{"RULE-1": true, "RULE-1 / Child": true}); len(sections) != 1 || !strings.Contains(sections[0].ContentMarkdown, "child") {
		t.Fatalf("subtree dedup=%+v", sections)
	}
	for _, tc := range []struct{ name, source, kind, quote, prefix, suffix, want string }{
		{"lines moved", "## [RULE-1] Rules\ninserted\nold quote\n", "lines", "old quote", "", "", "moved"},
		{"ambiguous", "## [RULE-1] Rules\nold quote\nold quote\n", "lines", "old quote", "", "", "outdated"},
		{"removed", "## Other\nold quote\n", "section", "", "", "", "outdated"},
		{"stable section", "## [RULE-1] Renamed\nchanged\n", "section", "", "", "", "exact"},
		{"rendered text", "## [RULE-1] Rules\n**old quote**\n", "text", "old quote", " ", "", "moved"},
		{"context ambiguous", "## [RULE-1] Rules\nold quote old quote\n", "text", "old quote", "", "", "section_only"},
		{"text context selects one", "## [RULE-1] Rules\nold quote then old quote\n", "text", "old quote", "then ", "", "moved"},
		{"text gone", "## [RULE-1] Rules\nnew\n", "text", "old quote", "", "", "section_only"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			location, located := LocateAnnotation("domain_rules", tc.source, 3, false, AnnotationAnchor{Kind: tc.kind, Section: "RULE-1", Quote: tc.quote, Prefix: tc.prefix, Suffix: tc.suffix})
			if location != tc.want {
				t.Fatalf("location=%s want %s", location, tc.want)
			}
			if tc.name == "lines moved" && (located == nil || *located.LineStart != 3 || *located.LineEnd != 3) {
				t.Fatalf("moved line=%+v", located)
			}
		})
	}
	location, located := LocateAnnotation("domain_rules", source, 2, true, AnnotationAnchor{Kind: "lines", Section: "RULE-1", LineStart: 2, LineEnd: 3})
	if location != "exact" || *located.LineStart != 2 || *located.LineEnd != 3 {
		t.Fatal("same revision lost original location")
	}
}

func TestAnnotationTicketEscapesEveryMentionSurface(t *testing.T) {
	input := "```\n[@other](mention://agent/abc) & [link](https://x)\n```"
	got := AnnotationTicketText(input)
	if strings.Contains(got, "mention://") || strings.ContainsAny(got, "\r\n`") {
		t.Fatalf("unsafe ticket text: %s", got)
	}
	const summary = `Keep "quotes" & <text> 'unchanged'`
	if got := html.UnescapeString(AnnotationTicketText(summary)); got != summary {
		t.Fatalf("escaping changed displayed summary: %s", got)
	}
}
