package handler

import (
	"fmt"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func BenchmarkLabrastroResolveCandidates(b *testing.B) {
	src := &labrastroSkillSource{spec: githubSpec{owner: "fixture", repo: "skills"}}
	a := labrastroSkillActor{ws: labrastroNewID(), user: labrastroNewID()}
	snap := labrastroPackageSnapshot{Member: db.Member{Role: "member"}}
	raw := make([]LabrastroSkillCandidate, 1024)
	for i := range raw {
		raw[i] = LabrastroSkillCandidate{Path: fmt.Sprintf("skills/%04d", i), Name: fmt.Sprintf("skill-%04d", i), State: "new", DefaultSelected: true, CanWrite: true}
		if i < 1000 {
			snap.States = append(snap.States, db.LabrastroListSkillStatesRow{ID: labrastroNewID(), WorkspaceID: a.ws, Name: raw[i].Name, CreatedBy: a.user, Config: []byte(fmt.Sprintf(`{"origin":{"type":"github","owner":"fixture","repo":"skills","path":%q}}`, raw[i].Path))})
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cs := labrastroResolveCandidates(a, snap, src, raw, nil)
		if len(cs) != 1024 || cs[999].State != "adoptable" || cs[1000].State != "new" {
			b.Fatal("incorrect source resolution")
		}
	}
}

func TestLabrastroSourceIndexPreservesAmbiguityAndLegacySlugMatching(t *testing.T) {
	src := &labrastroSkillSource{spec: githubSpec{owner: "fixture", repo: "skills"}}
	a := labrastroSkillActor{ws: labrastroNewID(), user: labrastroNewID()}
	legacy := db.LabrastroListSkillStatesRow{ID: labrastroNewID(), CreatedBy: a.user, Name: "local display name", Config: []byte(`{"origin":{"type":"skills_sh","owner":"FIXTURE","repo":"SKILLS","source_url":"https://skills.sh/fixture/skills/alpha"}}`)}
	raw := []LabrastroSkillCandidate{{Path: "skills/alpha", Name: "alpha", State: "new", CanWrite: true}}
	snap := labrastroPackageSnapshot{States: []db.LabrastroListSkillStatesRow{legacy}, Member: db.Member{Role: "member"}}
	resolved := labrastroResolveCandidates(a, snap, src, raw, nil)
	if resolved[0].State != "adoptable" || resolved[0].SkillID != uuidToString(legacy.ID) {
		t.Fatalf("matching path basename and frontmatter should count once: %+v", resolved)
	}
	// A different candidate whose frontmatter matches the slug makes the
	// legacy origin ambiguous; neither candidate can claim that local skill.
	raw = append(raw, LabrastroSkillCandidate{Path: "skills/beta", Name: "alpha", State: "new", CanWrite: true})
	for _, c := range labrastroResolveCandidates(a, snap, src, raw, nil) {
		if c.SkillID != "" || c.State != "new" {
			t.Fatalf("ambiguous legacy slug was adopted: %+v", c)
		}
	}
	// Two local skills with the same explicit provenance must remain a
	// conflict even if one happens to match the candidate's display name.
	legacy.Config = []byte(`{"origin":{"type":"github","owner":"fixture","repo":"skills","path":"skills/alpha"}}`)
	duplicate := legacy
	duplicate.ID, duplicate.Name = labrastroNewID(), "alpha"
	snap.States = []db.LabrastroListSkillStatesRow{legacy, duplicate}
	resolved = labrastroResolveCandidates(a, snap, src, raw[:1], nil)
	if resolved[0].Conflict != "ambiguous_source" || resolved[0].CanWrite || resolved[0].DefaultSelected || resolved[0].SkillID != "" {
		t.Fatalf("source ambiguity was hidden by a name match: %+v", resolved)
	}
}
