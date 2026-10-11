package protocol

const (
	EventIssueTipCreated      = "issue_tip:created"
	EventIssueTipUpdated      = "issue_tip:updated"
	EventIssueTipStateChanged = "issue_tip_state:changed"
)

// YouShouldKnowContext is claim-only side-channel input. Daemons must never
// render it into the primary agent's briefing or task messages.
type YouShouldKnowContext struct {
	Version            int                 `json:"version"`
	IssueIdentifier    string              `json:"issue_identifier"`
	AnchorCommentID    *string             `json:"anchor_comment_id"`
	LatestHumanComment string              `json:"latest_human_comment"`
	ExistingTips       []YouShouldKnowTip  `json:"existing_tips"`
	KnownTopics        []string            `json:"known_topics"`
	LightTipCount      int                 `json:"light_tip_count"`
	CheckEverySteps    int                 `json:"check_every_steps"`
	Limits             YouShouldKnowLimits `json:"limits"`
}

type YouShouldKnowTip struct {
	ID   string `json:"id"`
	Tag  string `json:"tag"`
	Line string `json:"line"`
}

type YouShouldKnowLimits struct {
	Line        int `json:"line"`
	Title       int `json:"title"`
	Explanation int `json:"explanation"`
}
