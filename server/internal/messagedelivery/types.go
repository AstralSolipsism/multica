// Package messagedelivery implements the Labrastro result-delivery module
// (OL-25): saved rules ("结果推送") that push automation results to Feishu
// members, group chats and topics, with durable PostgreSQL-backed delivery
// decisions, lease-claimed sending, compensation scanning and a per-shard
// external receipt ledger.
//
// The module owns NO execution semantics: it never starts, re-runs or
// re-queues an automation. It only reads terminal automation results that
// already exist in autopilot_run (and the linked issue), decides once per
// (source event, normalized target), and delivers the frozen content.
//
// Reliability model (OL-23 plan):
//
//   - The unique dedup key on labrastro_message_delivery is the exactly-once
//     DECISION guarantee. The lease is only a scheduling optimization.
//   - EventBus wakeups are a latency hint. The compensator re-derives the
//     full missing set from persisted rows, so a lost event, a crash between
//     the source commit and the decision insert, or a second replica is
//     always recovered.
//   - A send whose outcome nobody observed becomes "uncertain", never
//     silently retried; manual retries replay the SAME per-shard send UUID.
package messagedelivery

import (
	"errors"
	"fmt"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Delivery lifecycle statuses stored in labrastro_message_delivery.status.
const (
	DeliveryStatusQueued     = "queued"
	DeliveryStatusSending    = "sending"
	DeliveryStatusSent       = "sent"
	DeliveryStatusFailed     = "failed"
	DeliveryStatusUncertain  = "uncertain"
	DeliveryStatusCancelled  = "cancelled"
	DeliveryStatusSuppressed = "suppressed"
)

// Source kinds. run_only / create_issue read terminal autopilot_run rows;
// test_send records manual test sends for audit.
const (
	SourceKindRunOnly     = "run_only"
	SourceKindCreateIssue = "create_issue"
	SourceKindTestSend    = "test_send"
	SourceKindUnknown     = "unknown"
)

// Route target types.
const (
	TargetMember = "member"
	TargetGroup  = "group"
	TargetTopic  = "topic"
)

// Route condition values: which run outcomes the route delivers.
const (
	ConditionSuccess = "success"
	ConditionFailure = "failure"
	ConditionAll     = "all"
)

// Route content modes: digest only, or digest plus the run's final output.
const (
	ContentSummary    = "summary"
	ContentWithOutput = "with_output"
)

// Stable machine-readable error codes recorded on delivery rows and
// returned by the HTTP API. The strings are contract; the sentences next to
// them are not.
const (
	ErrorCodeRouteDisabled       = "route_disabled"
	ErrorCodeRouteDeleted        = "route_deleted"
	ErrorCodeSourceArchived      = "source_archived"
	ErrorCodeSourceMissing       = "source_missing"
	ErrorCodeConditionMismatch   = "condition_mismatch"
	ErrorCodeMemberUnbound       = "member_unbound"
	ErrorCodeInstallationRevoked = "installation_revoked"
	ErrorCodeInstallationMissing = "installation_missing"
	ErrorCodeSendRejected        = "send_rejected"
	ErrorCodeSendTransient       = "send_transient"
	ErrorCodeSenderUnavailable   = "sender_unavailable"
	ErrorCodeAttemptsExhausted   = "attempts_exhausted"
	ErrorCodeLeaseExpired        = "lease_expired"
	ErrorCodeSendAmbiguous       = "send_ambiguous"
	// Target-verification verdicts (review R1) and authorization-loss
	// handling (review R2).
	ErrorCodeTargetUnverifiable  = "route_target_unverifiable"
	ErrorCodeTargetUnreachable   = "route_target_unreachable"
	ErrorCodeTopicAnchorMismatch = "route_topic_anchor_mismatch"
	ErrorCodeAuthorizationLost   = "route_authorization_lost"
	ErrorCodeTargetNotApproved   = "route_target_not_approved"
)

// ValidRouteConditions / ValidContentModes are the accepted API values.
var ValidRouteConditions = map[string]bool{
	ConditionSuccess: true,
	ConditionFailure: true,
	ConditionAll:     true,
}

var ValidContentModes = map[string]bool{
	ContentSummary:    true,
	ContentWithOutput: true,
}

var ValidTargetTypes = map[string]bool{
	TargetMember: true,
	TargetGroup:  true,
	TargetTopic:  true,
}

// Terminal run statuses the module reads as deliverable sources. Skipped
// runs are terminal too and get a suppressed decision, never a send.
var terminalRunStatuses = map[string]bool{
	"completed": true,
	"failed":    true,
	"skipped":   true,
}

// TargetKey is the canonical identity of a delivery target. Two routes with
// the same key are the same destination for dedup purposes, no matter how
// they were entered.
func TargetKey(targetType string, targetUserID, targetChatID, targetMessageID string) string {
	switch targetType {
	case TargetMember:
		return "member:" + targetUserID
	case TargetGroup:
		return "group:" + targetChatID
	case TargetTopic:
		return "topic:" + targetChatID + ":" + targetMessageID
	}
	return targetType + ":unknown"
}

// DeliveryDedupKey identifies the (source event, normalized target) pair a
// decision belongs to. Same key ⇒ same decision, enforced by
// uq_labrastro_message_delivery_dedup across replicas and enqueuers.
func DeliveryDedupKey(runID, installationID, targetKey string) string {
	return "run:" + runID + ":" + installationID + ":" + targetKey
}

// TestDeliveryDedupKey namespaces manual test sends so they can never
// collide with (or suppress) a real source event.
func TestDeliveryDedupKey(sendID string) string {
	return "test:" + sendID
}

// routeMatchesRun reports whether the route's condition selects this run's
// terminal status. Skipped runs match nothing by design ("跳过默认关闭").
func routeMatchesRun(conditions, runStatus string) bool {
	switch runStatus {
	case "completed":
		return conditions == ConditionSuccess || conditions == ConditionAll
	case "failed":
		return conditions == ConditionFailure || conditions == ConditionAll
	}
	return false
}

// sourceKindFromRun derives the source kind from the run's PERSISTED
// evidence, never from the autopilot's current configuration (review R7): a
// run_only run keeps its task link and its output even if the rule is later
// switched to create_issue. issue_id implies create_issue (the run owns
// that issue); otherwise a task link implies run_only; otherwise a result
// payload carrying `output` is by definition a run_only completion; the
// absence of evidence is explicit and never follows mutable configuration.
func sourceKindFromRun(runIssueIDValid, runTaskIDValid bool, runResult []byte, _ string) string {
	switch {
	case runIssueIDValid:
		return SourceKindCreateIssue
	case runTaskIDValid:
		return SourceKindRunOnly
	}
	if _, hasOutput := extractRunOnlyOutput(runResult); hasOutput {
		return SourceKindRunOnly
	}
	return SourceKindUnknown
}

// Target is the resolved wire-level destination the Sender dials.
type Target struct {
	Type      string `json:"target_type"`
	OpenID    string `json:"open_id,omitempty"`
	ChatID    string `json:"chat_id,omitempty"`
	MessageID string `json:"message_id,omitempty"`
	ThreadID  string `json:"thread_id,omitempty"`
}

// targetFromSnapshot re-reads the frozen target. The send path re-resolves
// the LIVE member binding before dialing; for group/topic targets the
// frozen addresses ARE the wire addresses (an external chat id does not
// rotate server-side).
func targetFromSnapshot(snap targetSnapshot) Target {
	return Target{
		Type:      snap.TargetType,
		OpenID:    snap.OpenID,
		ChatID:    snap.ChatID,
		MessageID: snap.MessageID,
		ThreadID:  snap.ThreadID,
	}
}

// targetSnapshot is the JSON shape frozen into
// labrastro_message_delivery.target_snapshot at decision time.
type targetSnapshot struct {
	TargetType   string `json:"target_type"`
	ChannelType  string `json:"channel_type"`
	Installation string `json:"installation_id"`
	UserID       string `json:"user_id,omitempty"`
	OpenID       string `json:"open_id,omitempty"`
	ChatID       string `json:"chat_id,omitempty"`
	MessageID    string `json:"message_id,omitempty"`
	ThreadID     string `json:"thread_id,omitempty"`
}

// TargetKeyFor re-derives the canonical target key from the frozen
// snapshot — the identity send-time approval checks are keyed on (repair
// contract §2: send-time checks match the FROZEN target, never the live
// route).
func (t targetSnapshot) TargetKeyFor() string {
	return TargetKey(t.TargetType, t.UserID, t.ChatID, t.MessageID)
}

// contentSnapshot is the JSON shape frozen into
// labrastro_message_delivery.content_snapshot at decision time. Text is the
// fully rendered message; shards are a pure function of it, so a retry can
// never re-split the body differently.
type contentSnapshot struct {
	Text      string `json:"text"`
	Summary   string `json:"summary"`
	RunStatus string `json:"run_status"`
	HasOutput bool   `json:"has_output"`
	Link      string `json:"link,omitempty"`
}

// sourceRef is the JSON shape frozen into
// labrastro_message_delivery.source_ref. It LOCATES the source for the
// feedback stage; it never grants access by itself.
type sourceRef struct {
	RunID           string `json:"run_id"`
	ExecutionMode   string `json:"execution_mode,omitempty"`
	IssueID         string `json:"issue_id,omitempty"`
	IssueIdentifier string `json:"issue_identifier,omitempty"`
	IssueStatus     string `json:"issue_status,omitempty"`
}

// ---- errors the HTTP layer maps to stable codes ----

var (
	// Refusals after re-reading the source and its acting human.
	ErrSourceUnavailable      = errors.New("message source is unavailable")
	ErrAuthorizationLost      = errors.New("message authorization lost")
	ErrApprovedTargetNotFound = errors.New("approved target not found")
	// ErrRouteNotFound: the route id does not exist in this workspace.
	ErrRouteNotFound = errors.New("message route not found")
	// ErrRouteRevisionConflict: the caller's revision is stale.
	ErrRouteRevisionConflict = errors.New("message route revision conflict")
	// ErrRouteAlreadyExists: an equivalent route already exists.
	ErrRouteAlreadyExists = errors.New("message route already exists")
	// ErrDeliveryNotFound: the delivery id does not exist in this workspace.
	ErrDeliveryNotFound = errors.New("message delivery not found")
	// ErrDeliveryNotRetryable: the delivery status cannot be retried.
	ErrDeliveryNotRetryable = errors.New("message delivery is not retryable")
)

// InvalidRouteError names the field a rejected route payload failed on.
type InvalidRouteError struct{ Field string }

func (e *InvalidRouteError) Error() string {
	return fmt.Sprintf("invalid message route: %s", e.Field)
}

// InstallationInvalidError: the referenced bot installation cannot be used.
type InstallationInvalidError struct{ Reason string }

func (e *InstallationInvalidError) Error() string {
	return "invalid installation: " + e.Reason
}

// MemberNotBoundError: the target member has no platform binding on THIS
// installation, so a member DM cannot be addressed.
type MemberNotBoundError struct{}

func (e *MemberNotBoundError) Error() string {
	return "target member has no binding on this installation"
}

// TargetNotMemberError: the target user is not a member of this workspace.
type TargetNotMemberError struct{}

func (e *TargetNotMemberError) Error() string {
	return "target user is not a member of this workspace"
}

// TargetUnverifiableError: the deployment has no transport wired to verify
// an external target, so the save fails closed (review R1: a group/topic
// target must be verifiable, and a later test-send cannot substitute for
// save-time verification).
type TargetUnverifiableError struct{ Detail string }

func (e *TargetUnverifiableError) Error() string {
	msg := "external targets cannot be verified without a configured channel transport"
	if e.Detail != "" {
		return msg + ": " + e.Detail
	}
	return msg
}

// TargetUnreachableError: the platform definitively refused the target
// (unknown chat, bot not a member, outside visibility).
type TargetUnreachableError struct{ Detail string }

func (e *TargetUnreachableError) Error() string {
	return "target is not reachable by this bot: " + e.Detail
}

// TargetAnchorMismatchError: the topic anchor lives in a different chat
// than the route declared. The verified chat wins; the save is refused.
type TargetAnchorMismatchError struct{ Detail string }

func (e *TargetAnchorMismatchError) Error() string {
	return "topic anchor belongs to a different chat: " + e.Detail
}

// TargetNotApprovedError: the (source, bot, normalized target) triple has no
// active workspace-admin approval (repair contract §2, review R1). Group and
// topic targets require approval; member targets do not enter the approval
// table.
type TargetNotApprovedError struct{}

func (e *TargetNotApprovedError) Error() string {
	return "target has no active approval by a workspace admin"
}

// sourceFacts is the persisted evidence of one terminal run, assembled in
// ONE place (decisionInputFromSource) for every enqueue path — direct event
// wakeup and the compensator share it, so neither can forget a field the
// other carries (repair contract §3, review R7).
type sourceFacts struct {
	RunID               string
	RunStatus           string
	RunCompletedAt      time.Time
	RunCompletedAtValid bool
	TaskID              string
	TaskIDValid         bool
	IssueID             string
	IssueIDValid        bool
	Result              []byte
	FailureReason       string
	ReasonCode          string
}

// decisionInput carries everything one delivery decision is built from. The
// event path and the compensator both end here, so the two can never drift.
type decisionInput struct {
	WorkspaceID    string
	AutopilotID    string
	RunID          string
	RunStatus      string
	RunCompletedAt time.Time
	// RunCompletedAtValid mirrors run.completed_at IS NOT NULL; the
	// eligibility window only applies to runs that have one.
	RunCompletedAtValid bool
	ExecutionMode       string
	RunTaskID           string
	RunTaskIDValid      bool
	Route               db.LabrastroMessageRoute
	Run                 runFields
}

// runFields is the slice of the source run a decision freezes.
type runFields struct {
	Result        []byte
	FailureReason string
	ReasonCode    string
	IssueID       string
	IssueIDValid  bool
}
