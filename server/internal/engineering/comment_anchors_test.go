package engineering

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestCommentAnchorsGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/anchors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Markdown string
		Texts    []struct{ Anchor, Title, Text string }
		Selector CommentSelector
		Expected CommentLocation
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			sections := CommentSections(tc.Markdown)
			if len(sections) != len(tc.Texts) {
				t.Fatalf("sections=%+v want %+v", sections, tc.Texts)
			}
			for i, s := range sections {
				if s.Anchor != tc.Texts[i].Anchor || s.Title != tc.Texts[i].Title || s.Text != tc.Texts[i].Text {
					t.Errorf("section=%+v want %+v", s, tc.Texts[i])
				}
			}
			if got := LocateComment(sections, tc.Selector); !reflect.DeepEqual(got, tc.Expected) {
				t.Errorf("location=%+v want %+v", got, tc.Expected)
				if got.Start != nil && tc.Expected.Start != nil {
					t.Errorf("start=%d want %d", *got.Start, *tc.Expected.Start)
				}
			}
		})
	}
}

func TestCompleteCommentQuote(t *testing.T) {
	sections := CommentSections("## A\n😀 one needle\n## B\nneedle")
	if _, err := CompleteCommentQuote(sections, "", "needle", 1); err == nil || err.Error() != "baseline_quote_ambiguous" {
		t.Fatal(err)
	}
	if _, err := CompleteCommentQuote(sections, "A", "missing", 1); err == nil || err.Error() != "baseline_quote_not_found" {
		t.Fatal(err)
	}
	got, err := CompleteCommentQuote(sections, "A", "needle", 2)
	if err != nil || got.Start == nil || *got.Start != 9 || got.Prefix != "A 😀 one " || got.RevisionNumber != 2 {
		t.Fatalf("%+v %v", got, err)
	}
}
