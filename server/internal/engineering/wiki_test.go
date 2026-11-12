package engineering

import (
	"encoding/json"
	"os"
	"testing"
)

type wikiFixturePage struct {
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Content  string `json:"content"`
	Archived bool   `json:"archived"`
}

type wikiFixtureCase struct {
	Page          string `json:"page"`
	Raw           string `json:"raw"`
	Kind          string `json:"kind"`
	State         string `json:"state"`
	TargetSlug    string `json:"target_slug"`
	SectionAnchor string `json:"section_anchor"`
}

type wikiFixtureBacklinks struct {
	Target string `json:"target"`
	Expect []struct {
		Slug          string `json:"slug"`
		SectionAnchor string `json:"section_anchor"`
	} `json:"expect"`
}

type wikiFixture struct {
	Pages     []wikiFixturePage      `json:"pages"`
	Extract   map[string][]string    `json:"extract"`
	Cases     []wikiFixtureCase      `json:"cases"`
	Backlinks []wikiFixtureBacklinks `json:"backlinks"`
}

func loadWikiFixture(t *testing.T) ([]WikiPageContent, map[string]int, *wikiFixture) {
	t.Helper()
	raw, err := os.ReadFile("testdata/wikilinks.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture wikiFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	pages := []WikiPageContent{}
	at := map[string]int{}
	for _, p := range fixture.Pages {
		if p.Archived {
			continue
		}
		at[p.Slug] = len(pages)
		pages = append(pages, WikiPageContent{Slug: p.Slug, Title: p.Title, Content: p.Content})
	}
	return pages, at, &fixture
}

// TestWikiLinksGoldenFixture locks extraction, resolution and backlinks against
// the same fixture the vitest suite loads (contract §7.2).
func TestWikiLinksGoldenFixture(t *testing.T) {
	pages, at, fixture := loadWikiFixture(t)
	idx := NewWikiIndex(pages)

	for slug, want := range fixture.Extract {
		got := ExtractWikiLinks(pages[at[slug]].Content)
		if len(got) != len(want) {
			t.Fatalf("%s: extracted %v, want %v", slug, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s: extracted[%d]=%q, want %q", slug, i, got[i], want[i])
			}
		}
	}
	for _, c := range fixture.Cases {
		link := idx.ResolveWikiLink(at[c.Page], c.Raw)
		if link.Kind != c.Kind || link.State != c.State || link.TargetSlug != c.TargetSlug || link.SectionAnchor != c.SectionAnchor {
			t.Fatalf("%s: [[%s]] = %+v, want kind=%s state=%s target=%s anchor=%s", c.Page, c.Raw, link, c.Kind, c.State, c.TargetSlug, c.SectionAnchor)
		}
	}
	for _, b := range fixture.Backlinks {
		got := idx.BacklinksFor(b.Target)
		if len(got) != len(b.Expect) {
			t.Fatalf("backlinks(%s) = %+v, want %+v", b.Target, got, b.Expect)
		}
		for i, want := range b.Expect {
			if got[i].Slug != want.Slug || got[i].SectionAnchor != want.SectionAnchor {
				t.Fatalf("backlinks(%s)[%d] = %+v, want %+v", b.Target, i, got[i], want)
			}
		}
	}
}

// The fixture is the definition of the backlink invariant: every resolved link
// from another page appears exactly once, and nothing else does.
func TestWikiBacklinksMatchResolvedForwardLinks(t *testing.T) {
	pages, _, fixture := loadWikiFixture(t)
	idx := NewWikiIndex(pages)
	for _, target := range fixture.Pages {
		want := 0
		for i, p := range pages {
			if p.Slug == target.Slug {
				continue
			}
			for _, link := range idx.LinksFor(i) {
				if link.Kind == "page" && link.State == "resolved" && link.TargetSlug == target.Slug {
					want++
				}
			}
		}
		if got := len(idx.BacklinksFor(target.Slug)); got != want {
			t.Fatalf("backlinks(%s) = %d entries, forward links say %d", target.Slug, got, want)
		}
	}
}

func TestWikiSearchSnippet(t *testing.T) {
	content := "# Page\n\nIntro text here.\n\n## Services\n\nThe scheduler service runs jobs."
	hit := SearchSnippet("id-1", "scheduler", "Scheduler", content, "scheduler", "body")
	if hit.SectionAnchor != "Services" || hit.SectionTitle != "Services" || hit.Match != "body" {
		t.Fatalf("hit=%+v", hit)
	}
	if hit.Snippet == "" {
		t.Fatal("empty snippet")
	}
	titleHit := SearchSnippet("id-1", "scheduler", "Scheduler", content, "sched", "title")
	if titleHit.Match != "title" || titleHit.Snippet == "" {
		t.Fatalf("title hit=%+v", titleHit)
	}
}
