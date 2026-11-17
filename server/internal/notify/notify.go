// Package notify describes message-delivery events and delegates inbox preferences
// to the canonical inbox registry.
package notify

import "github.com/multica-ai/multica/server/internal/inbox"

// Preference groups are the user-configurable keys inside
// notification_preference.preferences. A group's value of "muted" silences
// its types. Types not in the catalog are always delivered (not
// configurable) — see PreferenceGroupForType.
const (
	GroupReactions     = inbox.GroupReactions
	GroupNewIssues     = inbox.GroupNewIssues
	GroupAssignments   = inbox.GroupAssignments
	GroupStatusChanges = inbox.GroupStatusChanges
	GroupComments      = inbox.GroupComments
	GroupMentions      = inbox.GroupMentions
	GroupUpdates       = inbox.GroupUpdates
	GroupAgentActivity = inbox.GroupAgentActivity
)

// InboxType describes one inbox item type the personal delivery source may
// forward. Label is a stable English gloss for API consumers; product UI
// translations live in packages/views/locales.
type InboxType struct {
	Type  string `json:"type"`
	Group string `json:"group"`
	Label string `json:"label"`
}

// inboxTypes lists the mutable inbox types exposed by personal delivery routes.
// TestInboxTypesMatchRegistry pins its membership and groups to inbox.Types.
var inboxTypes = []InboxType{
	{Type: "issue_created", Group: GroupNewIssues, Label: "Issue created"},
	{Type: "issue_assigned", Group: GroupAssignments, Label: "Issue assigned to you"},
	{Type: "unassigned", Group: GroupAssignments, Label: "Unassigned from issue"},
	{Type: "assignee_changed", Group: GroupAssignments, Label: "Assignee changed"},
	{Type: "status_changed", Group: GroupStatusChanges, Label: "Status changed"},
	{Type: "new_comment", Group: GroupComments, Label: "New comment"},
	{Type: "reaction_added", Group: GroupReactions, Label: "Reaction added"},
	{Type: "app_action_result", Group: GroupAgentActivity, Label: "App action result"},
	{Type: "mentioned", Group: GroupMentions, Label: "You were mentioned"},
	{Type: "priority_changed", Group: GroupUpdates, Label: "Priority changed"},
	{Type: "start_date_changed", Group: GroupUpdates, Label: "Start date changed"},
	{Type: "due_date_changed", Group: GroupUpdates, Label: "Due date changed"},
	{Type: "task_failed", Group: GroupAgentActivity, Label: "Agent run failed"},
}

// PreferenceGroupForType returns the preference group a notification type
// is configurable under, and whether the type is configurable at all.
// Unconfigurable types are always delivered.
func PreferenceGroupForType(notifType string) (string, bool) {
	g, ok := inbox.Group(notifType)
	return g, ok && g != ""
}

// IsMuted reports whether a parsed notification_preference map silences the
// given notification type. Unconfigurable types are never muted.
func IsMuted(prefs map[string]string, notifType string) bool {
	return inbox.Muted(prefs, notifType)
}

// InboxTypes returns the personal-source event catalog.
func InboxTypes() []InboxType {
	out := make([]InboxType, len(inboxTypes))
	copy(out, inboxTypes)
	return out
}

// ---- team-event sources (activity_log / comment) ----

// The canonical activity_log actions the team delivery source consumes.
// Exactly these two: they are the transitions the product treats as
// notification-worthy, and each has one canonical source record. Adding an
// action here widens what every team route forwards — pair it with a test.
const (
	ActivityActionStatusChanged   = "status_changed"
	ActivityActionAssigneeChanged = "assignee_changed"
)

// IsTeamActivityAction reports whether an activity_log action is a
// team-event delivery source.
func IsTeamActivityAction(action string) bool {
	return action == ActivityActionStatusChanged || action == ActivityActionAssigneeChanged
}

// The comment.type values the team delivery source forwards. Only plain
// comments: status_change entries would double the activity status source,
// and progress_update / system entries are pipeline chatter, not member
// notifications. The whitelist is explicit so a new comment type is NOT
// silently delivered to group chats.
const CommentTypeDeliverable = "comment"

// IsDeliverableCommentType reports whether a comment.type enters the team
// delivery source.
func IsDeliverableCommentType(commentType string) bool {
	return commentType == CommentTypeDeliverable
}

// statusLabels maps canonical issue status keys to human-readable labels for
// delivery message bodies. Custom statuses (which carry their own names)
// are rendered as-is.
var statusLabels = map[string]string{
	"backlog":     "Backlog",
	"todo":        "Todo",
	"in_progress": "In Progress",
	"in_review":   "In Review",
	"done":        "Done",
	"blocked":     "Blocked",
	"cancelled":   "Cancelled",
}

// StatusLabel renders an issue status key for a message body.
func StatusLabel(status string) string {
	if l, ok := statusLabels[status]; ok {
		return l
	}
	return status
}
