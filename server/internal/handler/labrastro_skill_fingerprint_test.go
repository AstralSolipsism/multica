package handler

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestLabrastroPackageFingerprintIgnoresWorkspacePin(t *testing.T) {
	actor := labrastroSkillActor{}
	source := &labrastroSkillSource{}
	snapshot := labrastroPackageSnapshot{}
	snapshot.Member.ID = parseUUID("11111111-1111-4111-8111-111111111111")
	snapshot.Member.Role = "member"
	want := labrastroPreviewFingerprint(actor, snapshot, source, nil)
	snapshot.Member.PinnedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	if got := labrastroPreviewFingerprint(actor, snapshot, source, nil); got != want {
		t.Fatal("workspace pin invalidated the skill package preview")
	}
	snapshot.Member.Role = "admin"
	if got := labrastroPreviewFingerprint(actor, snapshot, source, nil); got == want {
		t.Fatal("permission change did not invalidate the preview")
	}
	snapshot.Member.Role = "member"
	snapshot.Member.ID = parseUUID("22222222-2222-4222-8222-222222222222")
	if got := labrastroPreviewFingerprint(actor, snapshot, source, nil); got == want {
		t.Fatal("replacement membership did not invalidate the preview")
	}
}
