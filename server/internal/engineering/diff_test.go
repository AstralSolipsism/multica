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
	d, err := Compute("domain_rules", before, after, 4, exclusions)
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
	d, err := Compute("domain_rules", before, after, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Modified) != 1 || d.Modified[0].Anchor != "Rule-中文" || !strings.Contains(d.Modified[0].Before, "old") || strings.Contains(d.Modified[0].After, "not part of rule") {
		t.Fatalf("diff = %#v", d)
	}
	d, err = Compute("domain_rules", before, strings.ReplaceAll(strings.ReplaceAll(before, "\r\n", "\n"), "body  ", "body"), 1, "")
	if err != nil || len(d.Modified) != 0 {
		t.Fatalf("whitespace diff = %#v %v", d, err)
	}
}

func TestDeferMissingPool(t *testing.T) {
	d, err := Compute("exclusions_and_risks", "", "### [Defer-1] no issue\nRule-1 needs a pool\n### [Defer-2] valid\n[pool](mention://issue/01a1429f-69bf-7162-a5bc-e942b1ea79aa)\n### [Defer-3] valid\nOL-23", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(d.Warnings, []Warning{{"defer_missing_pool", "Defer-1"}}) || d.HasRuleCut() {
		t.Fatalf("diff = %#v", d)
	}
}

func TestDiffKeepsUnanchoredTextVisible(t *testing.T) {
	before := "### [Rule-1] Keep\nRequired\n## Details\nOld detail"
	after := strings.ReplaceAll(before, "Old detail", "New detail")
	d, err := Compute("domain_rules", before, after, 1, "")
	if err != nil || len(d.Modified) != 1 || d.Modified[0].Anchor != "_unanchored" || d.HasRuleCut() {
		t.Fatalf("unanchored edit hidden or extended rule: %+v, %v", d, err)
	}
}
