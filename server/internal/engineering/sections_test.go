package engineering

import (
	"errors"
	"strings"
	"testing"
)

func TestSlugValidation(t *testing.T) {
	for _, slug := range []string{"a", "overview", "auth-engine", "billing_2", strings.Repeat("a", 63)} {
		if !ValidSlug(slug) {
			t.Fatalf("rejected %q", slug)
		}
	}
	for _, slug := range []string{"", "-a", "Billing", "a/b", "中文", strings.Repeat("a", 64), "a\n", "00000000-0000-0000-0000-000000000001", "module:a"} {
		if ValidSlug(slug) {
			t.Fatalf("accepted %q", slug)
		}
	}
}

func TestSectionIndexAndOneHopRead(t *testing.T) {
	pages := []PageContent{
		{"billing", "# Billing\nIntro\n## Pay\nUses [[Term-1]] and Ledger.\n### Retry\nAgain\n## Pay later\nOther\n```\n## Fake\n```"},
		{"domain_rules", "## [Term-1] Account\nA customer account.\n\n为什么：Traceability.\n\nReferences [[Second hop]].\n## Ledger\nJournal of entries.\n\n### Why\nAuditability.\n## Second hop\nNever fetched recursively."},
	}
	index, err := Index(pages[0].Content)
	if err != nil || len(index) != 4 || index[2].Anchor != "Pay / Retry" || index[2].Level != 3 {
		t.Fatalf("index=%+v err=%v", index, err)
	}
	got, err := ReadSections(pages, "billing", "Pay")
	if err != nil || len(got.Sections) != 1 || !strings.Contains(got.Sections[0].ContentMarkdown, "### Retry") || strings.Contains(got.Sections[0].ContentMarkdown, "Pay later") {
		t.Fatalf("slice=%+v err=%v", got, err)
	}
	if len(got.ReferencedSections) != 2 || got.ReferencedSections[0].Definition != "A customer account." || got.ReferencedSections[0].Why != "Traceability." || got.ReferencedSections[1].Why != "Auditability." {
		t.Fatalf("references=%+v", got.ReferencedSections)
	}
	got, err = ReadSections(pages, "", "pAy")
	if err != nil || len(got.Sections) != 3 {
		t.Fatalf("partial=%+v err=%v", got, err)
	}
	got, err = ReadSections(pages, "", "Term-1")
	if err != nil || got.Sections[0].Title != "Account" {
		t.Fatalf("anchor=%+v err=%v", got, err)
	}
	t.Run("same chapter and overlapping cross chapter offsets", func(t *testing.T) {
		pages := []PageContent{
			{"billing", "## Selected\nUses [[Term-1]], Plain concept and Cross concept.\n## [Term-1] Account\nSame-chapter anchor reference.\n## Plain concept\nSame-chapter title reference."},
			// This heading starts at byte 0, inside the selected section's byte range
			// in the other chapter. Offsets alone must not mark it as selected.
			{"domain_rules", "## Cross concept\nCross-chapter reference."},
		}
		got, err := ReadSections(pages, "billing", "Selected")
		if err != nil || len(got.Sections) != 1 || len(got.ReferencedSections) != 3 {
			t.Fatalf("slice=%+v err=%v", got, err)
		}
		for i, want := range []struct{ chapter, anchor, definition string }{
			{"billing", "Term-1", "Same-chapter anchor reference."},
			{"billing", "Plain concept", "Same-chapter title reference."},
			{"domain_rules", "Cross concept", "Cross-chapter reference."},
		} {
			ref := got.ReferencedSections[i]
			if ref.Page != want.chapter || ref.Anchor != want.anchor || ref.Definition != want.definition {
				t.Errorf("reference[%d]=%+v, want %+v", i, ref, want)
			}
		}
	})
}

func TestMergeSectionPreservesOtherBytesAndDiff(t *testing.T) {
	before := "Preamble  \r\n\r\n## Keep\r\nUntouched  \r\n\r\n## [Rule-1] Change\r\nOld\r\n### Detail\r\nChild\r\n## Last\r\nLast body\r\n"
	got, err := MergeSection(before, "Rule-1", "New body", false)
	if err != nil || !strings.HasPrefix(got, before[:strings.Index(before, "## [Rule")]) || !strings.HasSuffix(got, "## Last\r\nLast body\r\n") || !strings.Contains(got, "## [Rule-1] Change\nNew body") || strings.Contains(got, "Child") {
		t.Fatalf("merged=%q err=%v", got, err)
	}
	d, err := Compute(before, got, 3)
	if err != nil || len(d.Modified) != 1 || d.Modified[0].Anchor != "Rule-1" || len(d.Removed) != 1 || d.UnchangedCount != 3 {
		t.Fatalf("diff=%+v err=%v", d, err)
	}
	added, err := MergeSection(got, "New", "Definition", false)
	if err != nil || !strings.HasPrefix(added, got) || !strings.Contains(added, "## New\nDefinition") {
		t.Fatalf("append=%q err=%v", added, err)
	}
	deleted, err := MergeSection(before, "Change", "", true)
	if err != nil || strings.Contains(deleted, "Rule-1") || strings.Contains(deleted, "Child") || !strings.HasSuffix(deleted, "## Last\r\nLast body\r\n") {
		t.Fatalf("delete=%q err=%v", deleted, err)
	}
}

func TestSectionEditErrors(t *testing.T) {
	for _, tt := range []struct {
		before, query, replacement string
		deleting                   bool
		code                       string
	}{
		{"## Same\nA\n## Same\nB", "Same", "New", false, "baseline_section_ambiguous"},
		{"## One", "Missing", "", true, "baseline_section_not_found"},
		{"## 计费规则\nKeep this body.\n", "规则", "", true, "baseline_section_not_found"},
		{"## One", "", "Text", false, "invalid_request"},
		{"## One", "One", "Text", true, "invalid_request"},
		{"## One", "One", "## One\nBody\n## Unrelated\nOops", false, "invalid_request"},
		{"## One\n" + strings.Repeat("x", 65520), "New", strings.Repeat("y", 100), false, "baseline_too_large"},
	} {
		_, err := MergeSection(tt.before, tt.query, tt.replacement, tt.deleting)
		var invalid *Error
		if !errors.As(err, &invalid) || invalid.Code != tt.code {
			t.Fatalf("%+v error=%v", tt, err)
		}
	}
}

func TestMergeSectionAppendsWithoutExactMatch(t *testing.T) {
	before := "## 计费规则\nKeep this body.\n"
	for _, replacement := range []string{"New rule.", "## 规则\nNew rule."} {
		t.Run(replacement, func(t *testing.T) {
			got, err := MergeSection(before, "规则", replacement, false)
			want := before + "## 规则\nNew rule.\n\n"
			if err != nil || got != want {
				t.Fatalf("merged=%q err=%v, want %q", got, err, want)
			}
		})
	}

	t.Run("adopted content without trailing newline", func(t *testing.T) {
		got, err := MergeSection("## A\nbody", "B", "New body", false)
		want := "## A\nbody\n## B\nNew body\n\n"
		if err != nil || got != want {
			t.Fatalf("merged=%q err=%v, want %q", got, err, want)
		}
	})
}

func TestSectionWhitespaceHeadingsAndLabeledRationale(t *testing.T) {
	content := "Intro\n##   \nBody\n###\t \n## Real\nDefinition.\n\n- **为什么这样规定**：To audit."
	parsed, err := Parse(content)
	if err != nil || len(parsed) != 2 || parsed[1].Anchor != "Real" {
		t.Fatalf("parse=%+v err=%v", parsed, err)
	}
	for _, body := range []string{"- **为什么这样规定**：To audit.", "**Why:** To audit.", "### Why\nTo audit.", "原因：To audit."} {
		if got := sectionWhy(body); got != "To audit." {
			t.Fatalf("body=%q why=%q", body, got)
		}
	}
	if got := sectionWhy("Whynot isn't a label"); got != "" {
		t.Fatal(got)
	}
	added, err := MergeSection("", "Root", "# Root\nBody\n## Child\nChild body", false)
	if err != nil || !strings.HasPrefix(added, "# Root\n") {
		t.Fatalf("append=%s err=%v", added, err)
	}
}
