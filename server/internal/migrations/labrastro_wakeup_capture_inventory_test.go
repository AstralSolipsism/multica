package migrations

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"
)

// A later upstream replacement runs AFTER 9009 on an upgraded database but
// BEFORE it on a fresh one. Require an explicit fork rebase migration whenever
// upstream changes this function, instead of letting install order set policy.
func TestLabrastroWakeupCaptureMigrationInventory(t *testing.T) {
	definition := regexp.MustCompile(`(?i)CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?capture_issue_wakeup\s*\(`)
	var found []string
	for _, path := range migrationFilesForLint(t, "*.up.sql") {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if definition.Match(body) {
			found = append(found, filepath.Base(path))
		}
	}
	want := []string{
		"518_wakeup_event_capture.up.sql",
		"520_collaboration_wakeup_events.up.sql",
		"523_wakeup_registration_source.up.sql",
		"530_wakeup_bounded_capture.up.sql",
		"532_wakeup_actor_capture.up.sql",
		"9009_labrastro_wakeup_conversation_provenance.up.sql",
	}
	if !reflect.DeepEqual(found, want) {
		t.Fatalf("capture_issue_wakeup definitions changed: got %v want %v; add a new fork migration that reapplies conversation provenance to the updated upstream function, and verify both fresh and upgrade order before updating this inventory", found, want)
	}
}
