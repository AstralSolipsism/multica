package engineering

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDiffChineseAnchorsAndWarnings(t *testing.T) {
	before := "前言\n### [Term-基线] 定义\n正本\n### [Rule-1] 保留规则\n一二三四五六七八九十\n### [Rule-2] 删除规则\n必须保留\n### [Rule-3] 恰好四成\n一二三四五六七八九十"
	after := "前言  \r\n\r\n### [Term-基线] 定义\r\n正本\r\n### [Rule-1] 保留规则\n一二三四五\n### [Rule-3] 恰好四成\n一二三四五六\n### [Term-新词] 新词\n新增"
	exclusions := "### [Defer-1] 延后\n[Rule-1] 转 OL-123\n### [Defer-2] 延后\nRule-20"
	d, err := Compute("domain_rules", before, after, 4, exclusions, "OL")
	if err != nil {
		t.Fatal(err)
	}
	want := []Warning{{"rule_shrunk", "Rule-1"}, {"rule_removed", "Rule-2"}, {"rule_deferred", "Rule-1"}}
	if !reflect.DeepEqual(d.Warnings, want) {
		t.Fatalf("warnings = %#v", d.Warnings)
	}
	if d.BaseRevisionNumber != 4 || len(d.Added) != 1 || len(d.Modified) != 2 || len(d.Removed) != 1 || d.UnchangedCount != 2 || !d.HasRuleCut() {
		t.Fatalf("unexpected diff: %#v", d)
	}
	if d.Modified[0].BeforeChars != 10 || d.Modified[0].AfterChars != 5 {
		t.Fatal("count must use Unicode characters")
	}
}

func TestDiffValidation(t *testing.T) {
	for _, tt := range []struct{ chapter, content, code string }{
		{"wrong", "", "baseline_anchor_invalid"},
		{"overview", "### [Rule-1] bad", "baseline_anchor_invalid"},
		{"overview", "### [Stage-一] A\n### [Stage-一] B", "baseline_anchor_duplicate"},
		{"overview", "### [Stage-] bad", "baseline_anchor_invalid"},
		{"overview", "### [Unknown-1] bad", "baseline_anchor_invalid"},
		{"overview", "### [Stage-" + strings.Repeat("字", 65) + "] bad", "baseline_anchor_invalid"},
		{"overview", strings.Repeat("字", 21846), "baseline_too_large"},
		{"overview", "\x00", "baseline_anchor_invalid"},
	} {
		t.Run(tt.code+tt.chapter, func(t *testing.T) {
			_, err := Parse(tt.chapter, tt.content)
			var e *Error
			if !errors.As(err, &e) || e.Code != tt.code {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestDiffFencesBoundariesNormalizationAndTitle(t *testing.T) {
	before := "intro\r\n\r\n\r\n### [Rule-中文] old\r\nbody  \r\n\r\n```md\n### [Rule-example] ignored\n```\n## Other\nnot part of rule"
	after := strings.ReplaceAll(before, "old", "new")
	d, err := Compute("domain_rules", before, after, 1, "", "OL")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Modified) != 1 || d.Modified[0].Anchor != "Rule-中文" || !strings.Contains(d.Modified[0].Before, "old") || strings.Contains(d.Modified[0].After, "not part of rule") {
		t.Fatalf("diff = %#v", d)
	}
	d, err = Compute("domain_rules", before, strings.ReplaceAll(strings.ReplaceAll(before, "\r\n", "\n"), "body  ", "body"), 1, "", "OL")
	if err != nil || len(d.Modified) != 0 {
		t.Fatalf("whitespace diff = %#v %v", d, err)
	}
}

func TestDeferMissingPool(t *testing.T) {
	d, err := Compute("exclusions_and_risks", "", "### [Defer-1] no issue\nRule-1 needs a pool\n### [Defer-2] valid\n[pool](mention://issue/01a1429f-69bf-7162-a5bc-e942b1ea79aa)\n### [Defer-3] valid\nOL-23", 0, "", "OL")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(d.Warnings, []Warning{{"defer_missing_pool", "Defer-1"}}) || d.HasRuleCut() {
		t.Fatalf("diff = %#v", d)
	}
}

func TestDeferIssueReferences(t *testing.T) {
	const issueID = "01a0e590-4ba8-7940-8dbe-756a9e6260ac"
	for _, tt := range []struct {
		name, text string
		missing    bool
	}{
		{"adr", "依赖 ADR-3 的结论", true},
		{"encoding", "统一 UTF-8 后再做", true},
		{"pull request", "PR-201 合并后再议", true},
		{"other workspace", "OTHER-1097", true},
		{"other workspace URL", "https://example.test/issues/OTHER-1097", true},
		{"identifier prefix", "XOL-1097", true},
		{"identifier suffix", "OL-1097x", true},
		{"bare UUID", issueID, true},
		{"invalid UUID link", "mention://issue/------------------------------------", true},
		{"identifier", "转入 OL-1097", false},
		{"identifier URL", "[pool](https://example.test/outlune/issues/OL-1097)", false},
		{"mention", "[pool](mention://issue/" + issueID + ")", false},
		{"UUID URL", "[pool](https://example.test/outlune/issues/" + issueID + ")", false},
		{"uppercase UUID URL", "/issues/" + strings.ToUpper(issueID), false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			for _, content := range []string{"### [Defer-1] Later\n" + tt.text, "### [Defer-1] " + tt.text} {
				d, err := Compute("exclusions_and_risks", "", content, 0, "", "OL")
				if err != nil {
					t.Fatal(err)
				}
				want := []Warning{}
				if tt.missing {
					want = append(want, Warning{"defer_missing_pool", "Defer-1"})
				}
				if !reflect.DeepEqual(d.Warnings, want) || d.HasRuleCut() {
					t.Fatalf("content=%q warnings=%+v want=%+v", content, d.Warnings, want)
				}
			}
		})
	}
}

func TestDeferWorkspaceIssuePrefix(t *testing.T) {
	for _, tt := range []struct {
		prefix, text string
		missing      bool
	}{
		{"TEAM", "TEAM-1097", false},
		{"TEAM", "OL-1097", true},
		{"O.L", "O.L-1097", false},
		{"O.L", "OXL-1097", true},
		{"", "OL-1097", true},
		{"", "x-1097", true},
		{"", "mention://issue/01a0e590-4ba8-7940-8dbe-756a9e6260ac", false},
	} {
		t.Run(tt.prefix+"/"+tt.text, func(t *testing.T) {
			d, err := Compute("exclusions_and_risks", "", "### [Defer-1] Later\n"+tt.text, 0, "", tt.prefix)
			if err != nil {
				t.Fatal(err)
			}
			want := []Warning{}
			if tt.missing {
				want = append(want, Warning{"defer_missing_pool", "Defer-1"})
			}
			if !reflect.DeepEqual(d.Warnings, want) {
				t.Fatalf("warnings=%+v want=%+v", d.Warnings, want)
			}
		})
	}
}

func TestDiffKeepsUnanchoredTextVisible(t *testing.T) {
	before := "### [Rule-1] Keep\nRequired\n## Details\nOld detail"
	after := strings.ReplaceAll(before, "Old detail", "New detail")
	d, err := Compute("domain_rules", before, after, 1, "", "OL")
	if err != nil || len(d.Modified) != 1 || d.Modified[0].Anchor != "_unanchored" || d.HasRuleCut() {
		t.Fatalf("unanchored edit hidden or extended rule: %+v, %v", d, err)
	}
}
