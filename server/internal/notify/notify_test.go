package notify

import "testing"

// The catalog is the drift guard between the inbox listeners and the
// delivery module: these tests pin the contract both sides depend on.

func TestPreferenceGroupForType(t *testing.T) {
	for _, tc := range []struct {
		notifType string
		wantGroup string
		wantOK    bool
	}{
		{"issue_assigned", GroupAssignments, true},
		{"unassigned", GroupAssignments, true},
		{"assignee_changed", GroupAssignments, true},
		{"status_changed", GroupStatusChanges, true},
		{"new_comment", GroupComments, true},
		{"mentioned", GroupMentions, true},
		{"due_date_changed", GroupUpdates, true},
		{"agent_blocked", GroupAgentActivity, true},
		{"totally_unknown", "", false},
	} {
		group, ok := PreferenceGroupForType(tc.notifType)
		if ok != tc.wantOK || group != tc.wantGroup {
			t.Errorf("PreferenceGroupForType(%q) = %q,%v want %q,%v", tc.notifType, group, ok, tc.wantGroup, tc.wantOK)
		}
	}
}

func TestIsMuted(t *testing.T) {
	prefs := map[string]string{GroupStatusChanges: "muted", GroupComments: "all"}
	if !IsMuted(prefs, "status_changed") {
		t.Error("muted group did not mute its type")
	}
	if IsMuted(prefs, "new_comment") {
		t.Error("non-muted value silenced its type")
	}
	// Unconfigurable types are always delivered.
	if IsMuted(prefs, "totally_unknown") {
		t.Error("unknown type was treated as configurable")
	}
	if IsMuted(nil, "mentioned") {
		t.Error("no preferences muted a configurable type")
	}
}

func TestTeamSourceWhitelists(t *testing.T) {
	if !IsTeamActivityAction("status_changed") || !IsTeamActivityAction("assignee_changed") {
		t.Error("canonical team activity actions rejected")
	}
	for _, action := range []string{"created", "priority_changed", "description_changed", ""} {
		if IsTeamActivityAction(action) {
			t.Errorf("non-team action %q accepted", action)
		}
	}
	if !IsDeliverableCommentType("comment") {
		t.Error("plain comment rejected")
	}
	for _, commentType := range []string{"status_change", "progress_update", "system", ""} {
		if IsDeliverableCommentType(commentType) {
			t.Errorf("comment type %q must not be a delivery source", commentType)
		}
	}
}

func TestStatusLabel(t *testing.T) {
	if StatusLabel("in_review") != "In Review" {
		t.Errorf("built-in label = %q", StatusLabel("in_review"))
	}
	if StatusLabel("custom_release_train") != "custom_release_train" {
		t.Errorf("custom status must pass through, got %q", StatusLabel("custom_release_train"))
	}
}
