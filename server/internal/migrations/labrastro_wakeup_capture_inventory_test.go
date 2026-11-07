package migrations

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

var captureWakeupDefinition = regexp.MustCompile(`(?i)CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?capture_issue_wakeup\s*\(`)

// Fork migrations 9009/9028 replaced upstream's capture_issue_wakeup and run
// AFTER any upstream migration on a fresh database. 9066 restores upstream's
// definition, so a fresh install still ends on the newest upstream body only
// while no later upstream migration redefines the function. A new upstream
// definition needs a new fork migration that re-applies it verbatim.
func TestLabrastroWakeupCaptureMigrationInventory(t *testing.T) {
	var found []string
	for _, path := range migrationFilesForLint(t, "*.up.sql") {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if captureWakeupDefinition.Match(body) {
			found = append(found, filepath.Base(path))
		}
	}
	want := []string{
		"518_wakeup_event_capture.up.sql",
		"520_collaboration_wakeup_events.up.sql",
		"523_wakeup_registration_source.up.sql",
		"530_wakeup_bounded_capture.up.sql",
		"532_wakeup_actor_capture.up.sql",
		"579_wakeup_skip_handed_to_agent.up.sql",
		"9009_labrastro_wakeup_conversation_provenance.up.sql",
		"9028_labrastro_wakeup_skip_handed_to_agent.up.sql",
		"9066_labrastro_retire_conversation_provenance.up.sql",
	}
	if !reflect.DeepEqual(found, want) {
		t.Fatalf("capture_issue_wakeup definitions changed: got %v want %v; add a new fork migration (after every 9xxx one) that re-applies the newest upstream definition verbatim, then update this inventory", found, want)
	}
}

// The last fork definition must be the newest upstream body, byte for byte.
func TestLabrastroWakeupCaptureMatchesUpstream(t *testing.T) {
	definition := func(file string) string {
		t.Helper()
		body := readMigrationFile(t, file)
		loc := captureWakeupDefinition.FindStringIndex(body)
		if loc == nil {
			t.Fatalf("%s does not define capture_issue_wakeup", file)
		}
		return strings.TrimSpace(body[loc[0]:])
	}
	upstream := definition("579_wakeup_skip_handed_to_agent.up.sql")
	if got := definition("9066_labrastro_retire_conversation_provenance.up.sql"); got != upstream {
		t.Fatal("9066 must restore upstream 579's capture_issue_wakeup verbatim")
	}
}
